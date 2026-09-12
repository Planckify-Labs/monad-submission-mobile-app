/**
 * Solana Pay builders — `SolanaWalletKit.buildPaymentRequest` (transfer
 * request, Class A) and the transaction-request fetch/validate path
 * (Class B). Spec §6.2; protocol text in `services/chains/solana/solanaPay.ts`.
 *
 * Both produce an unsigned base64 wire transaction for the existing
 * `SolanaTransactionSheet` (`signTransaction`, `mode: "sign-and-send"`),
 * so the program decoder and the simulation inspector run on the exact
 * bytes to be signed. Nothing here signs.
 */

import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  fetchMint,
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import type { ChainConfig } from "@/constants/configs/chainConfig";
import type { TWallet } from "@/constants/types/walletTypes";
import type { SolanaSignTxPayload } from "@/services/chains/solana/payloads";
import {
  amountToBaseUnits,
  type DecodedTx,
  parseTxRequestMetadata,
  validateAmount,
  validateTxRequest,
} from "@/services/chains/solana/solanaPay";
import { safeFetch } from "@/services/deeplinks/safeFetch";
import {
  type BuildContext,
  DeepLinkBuildError,
  type ExternalApprovalDraft,
  type Provenance,
} from "@/services/deeplinks/types";
import type { PaymentIntent } from "@/services/paymentIntent/types";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;
const KNOWN_TOKEN_PROGRAMS = new Set<string>([
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
]);

function assertSolanaChain(
  chain: ChainConfig,
): asserts chain is Extract<ChainConfig, { namespace: "solana" }> {
  if (chain.namespace !== "solana") {
    throw new DeepLinkBuildError("unsupported_chain");
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function memoInstruction(memo: string): Instruction {
  return {
    programAddress: MEMO_PROGRAM,
    accounts: [],
    data: new TextEncoder().encode(memo),
  };
}

function withReferences(ix: Instruction, references: string[]): Instruction {
  if (references.length === 0) return ix;
  return {
    ...ix,
    accounts: [
      ...(ix.accounts ?? []),
      ...references.map((r) => ({
        address: address(r),
        role: AccountRole.READONLY,
      })),
    ],
  };
}

function draftFor(
  wallet: TWallet,
  cluster: SolanaSignTxPayload["cluster"],
  transaction: string,
  provenance: Provenance,
  origin: { url: string; title?: string; icon?: string },
): ExternalApprovalDraft {
  const payload: SolanaSignTxPayload = {
    mode: "sign-and-send",
    address: wallet.address,
    cluster,
    version: 0,
    transaction,
  };
  return {
    namespace: "solana",
    kind: "signTransaction",
    origin: { ...origin, via: "deeplink" },
    wallet,
    payload,
    provenance,
    returnChannel: { kind: "broadcast" },
  };
}

// ── Class A: transfer request ─────────────────────────────────────────

export async function buildSolanaPaymentRequest(args: {
  wallet: TWallet;
  chain: ChainConfig;
  payment: PaymentIntent;
  provenance: Provenance;
}): Promise<ExternalApprovalDraft> {
  const { wallet, chain, payment, provenance } = args;
  assertSolanaChain(chain);
  const channel = payment.channel;
  if (channel.kind !== "wallet") throw new DeepLinkBuildError("malformed");
  const proto = (channel.protocol?.params ?? {}) as {
    references?: string[];
    label?: string;
    message?: string;
    memo?: string;
  };
  const references = Array.isArray(proto.references) ? proto.references : [];
  const amountRaw = channel.amountDecimal;
  if (amountRaw === undefined) {
    // "the wallet must prompt the user for the amount" — the interstitial
    // did not (no editable amount there); refuse with copy rather than
    // fabricate a value. Future work: an amount entry on the sheet.
    throw new DeepLinkBuildError("unsupported_operation");
  }

  const rpc = createSolanaRpc(chain.rpcUrl);
  const recipient = address(channel.address);
  const payer = createNoopSigner(address(wallet.address));

  // "recipient must be the base58-encoded public key of a native SOL
  // account" — reference `createTransfer` checks: exists, owned by the
  // System Program, not executable.
  const recipientInfo = await rpc
    .getAccountInfo(recipient, { encoding: "base64" })
    .send();
  const acct = recipientInfo.value;
  if (!acct || acct.owner !== SYSTEM_PROGRAM || acct.executable) {
    throw new DeepLinkBuildError("recipient_invalid");
  }

  let transferIx: Instruction;
  if (channel.token) {
    const mint = address(channel.token);
    const mintInfo = await rpc
      .getAccountInfo(mint, { encoding: "base64" })
      .send();
    const owner = mintInfo.value?.owner;
    if (!owner || !KNOWN_TOKEN_PROGRAMS.has(owner))
      throw new DeepLinkBuildError("malformed");
    const tokenProgram = owner as Address;
    const mintAccount = await fetchMint(rpc, mint);
    const decimals = mintAccount.data.decimals;
    if (validateAmount(amountRaw, decimals) !== "ok")
      throw new DeepLinkBuildError("malformed");
    const amount = amountToBaseUnits(amountRaw, decimals);
    const [senderAta] = await findAssociatedTokenPda({
      owner: payer.address,
      mint,
      tokenProgram,
    });
    const [recipientAta] = await findAssociatedTokenPda({
      owner: recipient,
      mint,
      tokenProgram,
    });
    // Reference behaviour: "recipient not found" when the ATA is absent
    // (Solana Pay never creates auxiliary or missing token accounts).
    const ataInfo = await rpc
      .getAccountInfo(recipientAta, { encoding: "base64" })
      .send();
    if (!ataInfo.value) throw new DeepLinkBuildError("recipient_invalid");
    transferIx = getTransferCheckedInstruction(
      {
        source: senderAta,
        mint,
        destination: recipientAta,
        authority: payer,
        amount,
        decimals,
      },
      { programAddress: tokenProgram },
    );
  } else {
    if (validateAmount(amountRaw, 9) !== "ok")
      throw new DeepLinkBuildError("malformed");
    const lamports = amountToBaseUnits(amountRaw, 9);
    transferIx = getTransferSolInstruction({
      source: payer,
      destination: recipient,
      amount: lamports,
    });
  }
  transferIx = withReferences(transferIx, references);

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    // "memo … must be included in an SPL Memo instruction … as the
    // second to last instruction"; the transfer is last.
    (m) =>
      proto.memo
        ? appendTransactionMessageInstruction(memoInstruction(proto.memo), m)
        : m,
    (m) => appendTransactionMessageInstruction(transferIx, m),
  );
  const tx = compileTransaction(message);
  const wire = getBase64EncodedWireTransaction(tx);

  return draftFor(wallet, chain.cluster, wire, provenance, {
    url: "link://solana-pay",
    title: proto.label ? `${proto.label} (from the link)` : undefined,
  });
}

// ── Class B: transaction request ──────────────────────────────────────

function decodeForValidation(
  bytes: Uint8Array,
): DecodedTx | { reject: "malformed" } {
  try {
    const vtx = VersionedTransaction.deserialize(bytes);
    const msg = vtx.message;
    const n = msg.header.numRequiredSignatures;
    return {
      bytes,
      messageBytes: msg.serialize(),
      signatures: vtx.signatures.map((s) => new Uint8Array(s)),
      requiredSigners: msg.staticAccountKeys
        .slice(0, n)
        .map((k) => k.toBase58()),
      version: msg.version === "legacy" ? "legacy" : 0,
    };
  } catch {
    return { reject: "malformed" };
  }
}

export async function buildSolanaPayTransactionRequest(args: {
  wallet: TWallet;
  link: string;
  host: string;
  cluster: "mainnet-beta" | "devnet";
  provenance: Provenance;
  ctx: BuildContext;
}): Promise<ExternalApprovalDraft> {
  const { wallet, link, host, cluster, provenance, ctx } = args;

  // GET → { label, icon } — "should", so a failure is non-fatal; a
  // malformed icon is fatal per spec.
  let label: string | undefined;
  let icon: string | undefined;
  try {
    const res = await safeFetch(link, {
      method: "GET",
      headers: { Accept: "application/json" },
      fetchImpl: ctx.fetch,
    });
    if (res.ok) {
      const meta = parseTxRequestMetadata(res.text, res.contentType);
      if (meta && "reject" in meta) throw new DeepLinkBuildError("malformed");
      label = meta?.label;
      icon = meta?.icon;
    }
  } catch (e) {
    if (e instanceof DeepLinkBuildError) throw e;
    if (__DEV__) console.warn("[solanaPay] metadata GET failed");
  }

  // POST { account } → { transaction, message? }
  let body: { transaction?: unknown; message?: unknown };
  try {
    const res = await safeFetch(link, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ account: wallet.address }),
      fetchImpl: ctx.fetch,
    });
    if (!res.ok) throw new DeepLinkBuildError("malformed");
    body = JSON.parse(res.text) as typeof body;
  } catch (e) {
    if (e instanceof DeepLinkBuildError) throw e;
    throw new DeepLinkBuildError("malformed", { detail: "post failed" });
  }
  if (typeof body.transaction !== "string")
    throw new DeepLinkBuildError("malformed");
  const message =
    typeof body.message === "string" ? body.message.slice(0, 256) : undefined;

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(body.transaction);
  } catch {
    throw new DeepLinkBuildError("malformed");
  }
  const decoded = decodeForValidation(bytes);
  if ("reject" in decoded) throw new DeepLinkBuildError("malformed");
  const verdict = validateTxRequest(decoded, wallet.address);
  if (!verdict.ok) throw new DeepLinkBuildError(verdict.code);

  let wire: string;
  if (verdict.needsFeePayerAndBlockhash) {
    const rpcUrl =
      cluster === "devnet"
        ? "https://api.devnet.solana.com"
        : "https://api.mainnet-beta.solana.com";
    const rpc = createSolanaRpc(rpcUrl);
    const { value: latest } = await rpc.getLatestBlockhash().send();
    if (decoded.version === "legacy") {
      const tx = Transaction.from(bytes);
      tx.feePayer = new PublicKey(wallet.address);
      tx.recentBlockhash = latest.blockhash;
      wire = bytesToBase64(
        new Uint8Array(
          tx.serialize({
            requireAllSignatures: false,
            verifySignatures: false,
          }),
        ),
      );
    } else {
      const vtx = VersionedTransaction.deserialize(bytes);
      vtx.message.staticAccountKeys[0] = new PublicKey(wallet.address);
      vtx.message.recentBlockhash = latest.blockhash;
      wire = bytesToBase64(vtx.serialize());
    }
  } else {
    wire = body.transaction;
  }

  const draft = draftFor(wallet, cluster, wire, provenance, {
    url: `https://${host}`,
    title: label,
    icon,
  });
  if (message) {
    (draft.payload as SolanaSignTxPayload).linkMessage = message;
  }
  return draft;
}
