/**
 * Fork-test harness (spec §11.3).
 *
 * §11.3 says a family may not be registered until its Layer-1 validator,
 * Layer-4 decode assertion and Layer-5 pause check have been fork-tested. This
 * is the thing that makes that sentence executable.
 *
 * ## What it actually proves
 *
 * The point is not "does some code produce plausible calldata". It is: take the
 * bytes **the device would sign**, put them on a real chain at a real block,
 * and check the user's position actually moved. So the tests drive the shipped
 * mobile adapters through their public `buildDeposit` / `buildWithdraw` — no
 * re-implementation, no hand-written calldata. A test that encoded the call
 * itself would only prove the test agrees with itself.
 *
 * The adapters read chain state through `getPublicClient(chain)`, which builds
 * its transport from `chain.rpcUrls.default.http[0]`. Pointing that at anvil is
 * therefore enough to run the real code path against the fork — nothing is
 * mocked or stubbed.
 *
 * ## Running
 *
 *   FORK_TESTS=1 FORK_RPC_URL_1=https://... \
 *   npx vitest run services/defi/__fork__
 *
 * Opt-in and skipped by default: it needs `anvil` on PATH, an archive-capable
 * upstream RPC, and tens of seconds per case. A chain with no `FORK_RPC_URL_*`
 * is skipped and named, because an unrun test must never read as a pass.
 *
 * Blocks are PINNED per chain. A floating head makes a failure unreproducible
 * and turns "a protocol changed" into "the test is flaky".
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  type Hex,
  http,
  keccak256,
  type PublicClient,
  parseAbi,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import { morphoSingleton } from "../constants/evmAddressBook";
import type { DepositTarget, UnsignedCall } from "../types";
import { approvalsOf } from "../types";

/** Anvil's first default account — funded, and its key is public by design. */
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

export const FORK_TESTS_ENABLED = process.env.FORK_TESTS?.trim() === "1";

/**
 * Pinned fork blocks. Bump deliberately, never automatically: a moving block is
 * how a fork suite becomes flaky and stops being believed.
 */
export const FORK_BLOCKS: Readonly<Record<number, bigint>> = {
  1: 23_000_000n,
  8453: 28_000_000n,
};

/**
 * A second, NEAR-HEAD pinned block per chain.
 *
 * ## Why a second pin at all
 *
 * `FORK_BLOCKS` cannot simply be bumped: every existing case is reproducible at
 * those blocks and moving them re-dates results nobody re-checked. But a
 * protocol onboarded today may not have EXISTED at them — Avant's `savETH` and
 * Tokemak's `baseUSD` both have zero code at 23,000,000 / 28,000,000
 * respectively (verified 2026-08-21), and a fork test against an undeployed
 * address fails for a reason that has nothing to do with the adapter.
 *
 * ## Why NEAR-HEAD rather than merely "later"
 *
 * The point of a fork is to be indistinguishable from mainnet. A pin that has
 * aged is not: vault parameters change, caps fill, a market's utilisation
 * moves, a proxy gets upgraded. Testing a vault at a block from two weeks ago
 * proves the adapter worked against a state nobody is depositing into any more.
 *
 * So these are pinned a few hundred blocks behind the head AT THE TIME THEY
 * WERE SET (2026-08-21: Ethereum head 25,803,477 / Base head 50,262,782),
 * which is close enough to be representative and far enough back that a reorg
 * or an archive endpoint's indexing lag cannot make the run flaky.
 *
 * **Bump these when you run a pass.** `forkPinAge()` warns when they have
 * drifted, so an aged pin announces itself rather than quietly testing history.
 * `FORK_BLOCK_<chainId>` overrides one without editing code.
 */
export const FORK_BLOCKS_RECENT: Readonly<Record<number, bigint>> = {
  1: 25_803_000n,
  8453: 50_262_000n,
};

/**
 * How far behind the head a near-head pin may drift before the harness says
 * so, per chain. Roughly one day of blocks: ~7,200 on Ethereum (12s), ~43,200
 * on Base (2s). Past that the fork is testing history, which is the one thing
 * a fork is supposed not to do.
 */
const PIN_STALE_AFTER_BLOCKS: Readonly<Record<number, bigint>> = {
  1: 7_200n,
  8453: 43_200n,
};

/**
 * Ask the upstream for its head and warn if the pinned block has aged out.
 *
 * Best-effort and never fatal: an endpoint that will not answer `eth_blockNumber`
 * is not a reason to fail a test, and a silent pass is exactly what this is
 * trying to prevent elsewhere. Same spirit as the dry run's `<< DARK` line —
 * "your evidence is weaker than it looks" should be told to you, not
 * discovered.
 */
async function warnIfPinIsStale(
  chainId: number,
  upstream: string,
  pinned: bigint,
): Promise<void> {
  const limit = PIN_STALE_AFTER_BLOCKS[chainId];
  if (!limit) return;
  try {
    const res = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
        params: [],
      }),
    });
    const body = (await res.json()) as { result?: string };
    if (!body.result) return;
    const head = BigInt(body.result);
    const age = head - pinned;
    if (age <= limit) return;
    console.warn(
      `[fork] chain ${chainId}: pinned block ${pinned} is ${age} blocks behind ` +
        `head ${head} (limit ${limit}). The fork is testing HISTORY — vault ` +
        "caps, utilisation and proxy implementations have moved since. Bump " +
        `FORK_BLOCKS_RECENT[${chainId}], or set FORK_BLOCK_${chainId}=${head - 200n}.`,
    );
  } catch {
    // Upstream would not answer. Not worth failing a run over.
  }
}

export function forkRpcUrl(chainId: number): string | undefined {
  return process.env[`FORK_RPC_URL_${chainId}`]?.trim() || undefined;
}

/**
 * Locate the anvil binary.
 *
 * foundryup installs to `~/.foundry/bin`, which is on an interactive shell's
 * PATH but not necessarily on a test runner's — a bare `spawn("anvil")` then
 * fails with a naked ENOENT that says nothing about foundry. `ANVIL_BIN`
 * overrides for a non-standard install.
 */
export function anvilBinary(): string {
  const override = process.env.ANVIL_BIN?.trim();
  if (override) return override;
  const home = process.env.HOME ?? "";
  const candidates = [`${home}/.foundry/bin/anvil`, "/usr/local/bin/anvil"];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Fall back to PATH resolution, which is right when foundry was installed by
  // a package manager.
  return "anvil";
}

/** True when this chain can actually be forked in the current environment. */
export function canFork(chainId: number): boolean {
  return FORK_TESTS_ENABLED && !!forkRpcUrl(chainId);
}

export interface ForkContext {
  chainId: number;
  rpcUrl: string;
  chain: ChainConfig;
  wallet: TWallet;
  account: Account;
  publicClient: PublicClient;
  walletClient: WalletClient;
  stop(): Promise<void>;
}

/**
 * Port allocation across vitest workers.
 *
 * Each test FILE runs in its own process, so a plain module-level counter
 * starts at the same number in every worker and the second fork dies with
 * "Address already in use". Seeding from the pid separates workers, and the
 * retry in `startFork` covers the rest (a leftover anvil, a collision after the
 * modulo wraps).
 */
let nextPort = 8600 + (process.pid % 200) * 4;
const PORT_ATTEMPTS = 8;

async function waitForRpc(
  url: string,
  hasExited: () => boolean = () => false,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Fail fast when anvil is already dead rather than waiting out the timeout
    // for a process that is never going to answer.
    if (hasExited()) throw new Error(`anvil exited before serving ${url}`);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });
      if (res.ok) return;
    } catch {
      // anvil is not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`anvil did not come up at ${url}`);
}

/**
 * Boot an anvil fork and hand back everything a test needs, including a
 * `ChainConfig` shaped exactly like the app's own so the adapters take their
 * real code path.
 */
export async function startFork(
  chainId: number,
  /**
   * Override the pinned block. MUST be another pinned constant (see
   * `FORK_BLOCKS_RECENT`) — passing a live head here would quietly reintroduce
   * exactly the flakiness `FORK_BLOCKS` exists to prevent.
   */
  opts?: { block?: bigint },
): Promise<ForkContext> {
  const upstream = forkRpcUrl(chainId);
  if (!upstream) throw new Error(`FORK_RPC_URL_${chainId} is not set`);

  // Retry on a taken port only. Any other failure (archive gating, bad URL) is
  // permanent and must surface immediately rather than be retried eight times.
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    try {
      return await startForkOnce(chainId, upstream, opts?.block);
    } catch (err) {
      lastError = err as Error;
      if (!/Address already in use/i.test(lastError.message)) throw lastError;
    }
  }
  throw lastError ?? new Error("startFork: exhausted port attempts");
}

async function startForkOnce(
  chainId: number,
  upstream: string,
  blockOverride?: bigint,
): Promise<ForkContext> {
  const port = nextPort++;
  const rpcUrl = `http://127.0.0.1:${port}`;
  // Precedence: explicit env override > the caller's pin > the shared pin.
  // The env hatch exists so "fork right now, at today's state" is a one-liner
  // rather than an edit — but it is still a NUMBER, not `latest`, so the run
  // stays reproducible by writing it down.
  const envBlock = process.env[`FORK_BLOCK_${chainId}`]?.trim();
  const block = envBlock
    ? BigInt(envBlock)
    : (blockOverride ?? FORK_BLOCKS[chainId]);

  // Forking at a PINNED block is an archive request, which most free endpoints
  // refuse ("Archive requests require a personal token"). `FORK_LATEST=1` trades
  // reproducibility for being able to run at all against such an endpoint.
  const useLatest = process.env.FORK_LATEST?.trim() === "1";
  if (useLatest) {
    // Loud, every run. A head fork makes results depend on live market state —
    // an Aave reserve at ~100% utilisation makes a perfectly correct MAX
    // withdraw revert, and the same test then passes an hour later. A green run
    // against a moving head is not evidence a family is safe to enable.
    console.warn(
      `[fork] chain ${chainId}: FORK_LATEST=1 — forking the HEAD. Results are not ` +
        "reproducible and a failure may be live market state rather than a bug. " +
        "Use an archive RPC and the pinned block before trusting a run.",
    );
  }

  if (block && !useLatest) await warnIfPinIsStale(chainId, upstream, block);

  const child: ChildProcess = spawn(
    anvilBinary(),
    [
      "--fork-url",
      upstream,
      ...(block && !useLatest ? ["--fork-block-number", String(block)] : []),
      "--port",
      String(port),
      // Pinned, not `latest`. anvil 1.7.1's default resolves to Osaka, on which
      // a plain `balanceOf` against forked mainnet state fails with
      // `EVM error OpcodeNotFound`. Prague executes the same state correctly.
      // Override with FORK_HARDFORK once anvil catches up.
      "--hardfork",
      process.env.FORK_HARDFORK?.trim() || "prague",
      // Deposits into a busy market can need more than the default cap once the
      // approve preamble is in the same block.
      "--gas-limit",
      "60000000",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  // Keep anvil's own output. Without it, an upstream that rejects the fork
  // (archive gating, rate limit, bad URL) shows up as a bare 60-second timeout
  // saying "anvil did not come up", which explains nothing — that cost a debug
  // cycle the first time this harness ran.
  let output = "";
  const capture = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  try {
    await waitForRpc(rpcUrl, () => exited);
  } catch (err) {
    child.kill("SIGKILL");
    const detail = output.trim().split("\n").slice(0, 12).join("\n");
    throw new Error(
      `${(err as Error).message}\n\nanvil said:\n${detail || "(no output)"}\n\n` +
        (detail.includes("Archive")
          ? `Hint: FORK_RPC_URL_${chainId} does not serve archive state. Use an archive ` +
            "endpoint, or set FORK_LATEST=1 to fork the head (not reproducible)."
          : ""),
    );
  }

  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  const chain: Chain = {
    id: chainId,
    name: `fork-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  }) as PublicClient;
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });

  return {
    chainId,
    rpcUrl,
    // The app's `ChainConfig` is a namespace-discriminated union wrapping the
    // viem chain — `assertEvmChain` reads `namespace`, so a bare viem `Chain`
    // here makes every adapter that touches chain state refuse.
    chain: { namespace: "eip155", chain } as unknown as ChainConfig,
    wallet: { address: account.address } as unknown as TWallet,
    account,
    publicClient,
    walletClient,
    async stop() {
      child.kill("SIGKILL");
    },
  };
}

// ── Funding ────────────────────────────────────────────────────────────────

const MAX_SLOT = 40;

/**
 * Give an address an ERC-20 balance by writing the token's storage — the same
 * trick as forge's `deal` cheatcode.
 *
 * Deliberately NOT "impersonate a whale": a whale list is a second table of
 * addresses to maintain and go stale, and draining a protocol contract to fund
 * a test can break the very invariant the test is about. Probing for the
 * balance slot needs no external data and works for any token.
 *
 * Both mapping layouts are tried — Solidity's `keccak256(holder, slot)` and
 * Vyper's `keccak256(slot, holder)` — because Curve's tokens use the latter.
 */
export async function dealErc20(
  ctx: ForkContext,
  token: Address,
  holder: Address,
  amount: bigint,
): Promise<void> {
  const readBalance = () =>
    ctx.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holder],
    });

  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await fetch(ctx.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return ((await res.json()) as { result?: unknown }).result;
  };

  const setStorage = (key: Hex, value: Hex) =>
    rpc("anvil_setStorageAt", [token, key, value]);

  /**
   * The ORIGINAL storage word at a key — not `balanceOf`.
   *
   * Reading the balance and writing that back as the "restore" value was the
   * first version of this, and it was wrong in a way that took a fork run to
   * find: probing walks slots 0..N, and for DAI slot 0 is the `wards` admin
   * mapping. Writing a balance there and then "restoring" a balance-derived
   * number left the token's storage corrupted, after which every later call
   * reverted with `EVM error OpcodeNotFound`. Restore what was actually there.
   */
  const getStorage = async (key: Hex): Promise<Hex> =>
    ((await rpc("eth_getStorageAt", [token, key, "latest"])) as Hex) ??
    (`0x${"0".repeat(64)}` as Hex);

  const encoded = (value: bigint): Hex =>
    `0x${value.toString(16).padStart(64, "0")}` as Hex;

  for (let slot = 0; slot < MAX_SLOT; slot++) {
    for (const layout of ["solidity", "vyper"] as const) {
      const key =
        layout === "solidity"
          ? keccak256(
              encodeAbiParameters(
                [{ type: "address" }, { type: "uint256" }],
                [holder, BigInt(slot)],
              ),
            )
          : keccak256(
              encodeAbiParameters(
                [{ type: "uint256" }, { type: "address" }],
                [BigInt(slot), holder],
              ),
            );

      const original = await getStorage(key);
      await setStorage(key, encoded(amount));

      let hit = false;
      try {
        hit = (await readBalance()) === amount;
      } catch {
        // A probe that makes the token unreadable is definitively the wrong
        // slot. Swallowing it here is what guarantees the restore below runs —
        // letting it propagate would leave the fork corrupted mid-probe.
        hit = false;
      }
      if (hit) return;

      await setStorage(key, original);
    }
  }
  throw new Error(`could not locate the balance slot for ${token}`);
}

/** Top up native balance (gas, and the deposit itself for native-asset LSTs). */
export async function dealNative(
  ctx: ForkContext,
  holder: Address,
  amount: bigint,
): Promise<void> {
  await fetch(ctx.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_setBalance",
      params: [holder, `0x${amount.toString(16)}`],
    }),
  });
}

// ── Execution ──────────────────────────────────────────────────────────────

export interface ExecResult {
  txHash: Hex;
  status: "success" | "reverted";
  gasUsed: bigint;
}

/**
 * Submit an `UnsignedCall` exactly the way the app does: every approve
 * preamble first (via `approvalsOf`, so a two-sided LP add cannot silently drop
 * its second approve), then the call itself.
 *
 * Simulated before sending, which is the §11 Layer-4 "simulate before sign"
 * check — a revert here is the same signal the device would get.
 */
export async function executeCall(
  ctx: ForkContext,
  call: UnsignedCall,
): Promise<ExecResult> {
  if (call.kind !== "evm-call") {
    throw new Error(`fork harness only executes evm-call, got ${call.kind}`);
  }

  for (const approval of approvalsOf(call)) {
    const hash = await ctx.walletClient.writeContract({
      account: ctx.account,
      chain: null,
      address: approval.token,
      abi: erc20Abi,
      functionName: "approve",
      args: [approval.spender, approval.amount],
    });
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`approve reverted for ${approval.token}`);
    }
  }

  // Simulate first: this is what the device does before asking for a signature,
  // so a fork test that skipped it would be testing a different flow.
  await ctx.publicClient.call({
    account: ctx.account.address,
    to: call.to,
    data: call.data,
    value: call.value ?? 0n,
  });

  const txHash = await ctx.walletClient.sendTransaction({
    account: ctx.account,
    chain: null,
    to: call.to,
    data: call.data,
    value: call.value ?? 0n,
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({
    hash: txHash,
  });

  if (receipt.status === "reverted") {
    // A bare "reverted" is useless for deciding whether the ADAPTER is wrong or
    // the PROTOCOL has changed. Replay the call one block back to recover the
    // reason, which is the whole reason a fork test beats a unit test here.
    let reason = "no reason recovered";
    try {
      await ctx.publicClient.call({
        account: ctx.account.address,
        to: call.to,
        data: call.data,
        value: call.value ?? 0n,
        blockNumber: receipt.blockNumber - 1n,
      });
    } catch (err) {
      reason = (err as Error).message.split("\n").slice(0, 6).join("\n");
    }
    throw new Error(
      `call to ${call.to} reverted (tx ${txHash}, gas ${receipt.gasUsed})\n${reason}`,
    );
  }

  return {
    txHash,
    status: receipt.status,
    gasUsed: receipt.gasUsed,
  };
}

// ── Assertions ─────────────────────────────────────────────────────────────

export async function erc20Balance(
  ctx: ForkContext,
  token: Address,
  holder: Address,
): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  });
}

const AAVE_ATOKEN_ABI = parseAbi([
  "function getReserveAToken(address asset) view returns (address)",
]);

const MORPHO_ABI = parseAbi([
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
]);

/** `getReserveData(address)` — return data is read positionally, see below. */
const GET_RESERVE_DATA_SELECTOR = "0x35ea6a75" as Hex;

/**
 * The aToken a given Aave-fork Pool issues for an asset.
 *
 * Two paths, because the family spans protocol versions and this is exactly the
 * kind of difference a fork test exists to surface:
 *
 *  - Aave v3.3 added `getReserveAToken(asset)`, which is unambiguous.
 *  - Older forks (SparkLend) do not have it and only expose `getReserveData`,
 *    whose `ReserveData` struct changed shape between v3.0 and v3.2. Decoding
 *    it against one declared layout silently produces a WRONG address on the
 *    other — which is what happened here first: garbage came back and the
 *    subsequent `balanceOf` failed with `EVM error OpcodeNotFound`.
 *
 * So the fallback reads the return data positionally instead of trusting a
 * struct declaration: every field of `ReserveData` is a single static word, and
 * `aTokenAddress` is the 9th in both layouts.
 */
export async function aTokenFor(
  ctx: ForkContext,
  pool: Address,
  asset: Address,
): Promise<Address> {
  try {
    const direct = (await ctx.publicClient.readContract({
      address: pool,
      abi: AAVE_ATOKEN_ABI,
      functionName: "getReserveAToken",
      args: [asset],
    })) as Address;
    if (direct && !/^0x0+$/.test(direct)) return direct;
  } catch {
    // Pre-3.3 fork — fall through to the positional read.
  }

  const { data } = await ctx.publicClient.call({
    to: pool,
    data: `${GET_RESERVE_DATA_SELECTOR}${asset.slice(2).padStart(64, "0")}` as Hex,
  });
  if (!data) throw new Error(`getReserveData returned nothing for ${asset}`);

  const WORD = 64; // 32 bytes as hex chars
  const ATOKEN_WORD_INDEX = 8;
  const body = data.slice(2);
  const word = body.slice(
    ATOKEN_WORD_INDEX * WORD,
    (ATOKEN_WORD_INDEX + 1) * WORD,
  );
  const address = `0x${word.slice(24)}` as Address;
  if (/^0x0+$/.test(address)) {
    throw new Error(
      `could not locate the aToken for ${asset} on pool ${pool} — the ReserveData layout may have changed again`,
    );
  }
  return address;
}

/**
 * The receipt-token balance a target's position is measured in. Centralised so
 * each family's test asserts "the position grew" the same way.
 */
export async function positionBalance(
  ctx: ForkContext,
  target: DepositTarget,
  holder: Address,
): Promise<bigint> {
  switch (target.kind) {
    case "erc4626":
    case "async-vault":
      return erc20Balance(ctx, target.vault as Address, holder);
    case "aave-v3":
      return erc20Balance(
        ctx,
        await aTokenFor(ctx, target.pool as Address, target.asset as Address),
        holder,
      );
    case "compound-v3":
      // Comet is its own receipt token.
      return erc20Balance(ctx, target.comet as Address, holder);
    case "compound-v2":
      return erc20Balance(ctx, target.cToken as Address, holder);
    case "lst-stake":
      return erc20Balance(ctx, target.receipt as Address, holder);
    case "morpho-blue": {
      // Morpho holds positions inside the singleton rather than issuing a
      // receipt token, so the position is `supplyShares` on the market.
      const singleton = morphoSingleton(ctx.chainId);
      if (!singleton) {
        throw new Error(`no Morpho singleton pinned for chain ${ctx.chainId}`);
      }
      const position = (await ctx.publicClient.readContract({
        address: singleton,
        abi: MORPHO_ABI,
        functionName: "position",
        args: [target.marketId, holder],
      })) as readonly [bigint, bigint, bigint];
      return position[0];
    }
    case "curve-lp":
      // Classic pools mint a SEPARATE LP token (§11.6c); NG pools are their
      // own LP token, matching `curveLp.ts:lpTokenOf`'s fallback.
      return erc20Balance(
        ctx,
        (target.lpToken ?? target.pool) as Address,
        holder,
      );
    case "solidly-lp":
      return erc20Balance(ctx, target.pool as Address, holder);
    default:
      throw new Error(
        `positionBalance: no receipt-token rule for kind "${target.kind}" — ` +
          "add one rather than asserting on something that is not the position",
      );
  }
}
