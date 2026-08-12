/**
 * JSON-RPC encoding validation at the bridge boundary — spec phase M.
 *
 * `normalizeTx` used to take the dApp's `data` as a **cast, not a
 * check** (`raw.data as Hex`), with no `isHex` and no length rule. The
 * consequences are all reproducible in `MetaMask/test-dapp`, and the
 * file that carries them is named `bypasses.js` for a reason:
 *
 *   0x095ea7b3…  (136 hex digits) → approve(address,uint256), flagged
 *   0x95ea7b30…  (135 hex digits) → selector miss, "contract interaction"
 *
 * Strip one leading zero from an approve and the 4-byte selector slice
 * lands on `0x95ea7b30`, misses `SELECTOR_DB`, and the unlimited-allowance
 * warning disappears. Same allowance, same attacker, no warning. The
 * scanner sees garbage; the chain sees an approve.
 *
 * The [JSON-RPC spec](https://ethereum.org/en/developers/docs/apis/json-rpc/)
 * settles the shape, which makes this enforcement rather than taste:
 *
 * > **Unformatted data:** encode as hex, prefix with `0x`, **two hex
 * > digits per byte**
 * > **Quantity:** encode as hex, prefix with `0x`
 *
 * ### Reject, do not repair
 *
 * Left-padding odd-length calldata to recover the "real" approve is
 * tempting and wrong. It guesses at what a node would do with a byte
 * string that is not a byte string, and if the guess is off we show a
 * confident decode of a transaction that executes differently. A
 * rejection the dApp can see and fix beats a rendering the user cannot
 * check.
 */

export type RpcParse<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

const HEX_BODY = /^[0-9a-fA-F]*$/;

function isAbsent(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/**
 * DATA: `0x`-prefixed, an even number of hex digits.
 *
 * Well-formed calldata is always even (a 4-byte selector plus 32-byte
 * words), so the even-length rule rejects nothing legitimate. Absent is
 * a valid answer — a plain value transfer carries no calldata.
 */
export function parseRpcData(v: unknown): RpcParse<`0x${string}` | undefined> {
  if (isAbsent(v)) return { ok: true, value: undefined };
  if (typeof v !== "string")
    return { ok: false, reason: "data must be a string" };
  const trimmed = v.trim();
  // A missing `0x` is tolerated and normalised. Unlike a QUANTITY there
  // is nothing to be ambiguous about — DATA is always hex — so refusing
  // it would break a dApp over punctuation. The even-length rule below
  // is the part that carries the security weight, and it applies
  // identically either way: the odd-length approve is still rejected
  // whether or not it arrived with a prefix.
  const body = (
    trimmed.startsWith("0x") || trimmed.startsWith("0X")
      ? trimmed.slice(2)
      : trimmed
  ).toLowerCase();
  if (!HEX_BODY.test(body)) return { ok: false, reason: "data is not hex" };
  if (body.length % 2 !== 0) {
    return { ok: false, reason: "data has an odd number of hex digits" };
  }
  return { ok: true, value: `0x${body}` as `0x${string}` };
}

/**
 * QUANTITY: `0x`-prefixed hex, or a plain decimal integer string.
 *
 * ### The correction
 *
 * This function originally required the `0x` prefix and rejected
 * everything else, reasoning that a bare `"100"` was ambiguous because a
 * hex-minded dApp might have meant `0x100`. **That was wrong, and it
 * broke real dApps.** tower.exchange sends a token approval as
 * `{ gas: "100000", maxFeePerGas: "0x9a997bf00", nonce: "0x20" }` —
 * decimal for one field, hex for the others — and we rejected the whole
 * transaction with `invalidParams: gas`, killing the swap before any
 * sheet appeared.
 *
 * The ambiguity I was defending against is not real. Nobody writes bare
 * hex without `0x` in JSON-RPC; a decimal-looking string is what you get
 * from `String(someBigInt)`, which is exactly how dApps produce these.
 * Rejecting it made us stricter than every wallet a dApp is tested
 * against, and being uniquely strict is indistinguishable from being
 * broken.
 *
 * ### What is still rejected, and why that is the part that mattered
 *
 * Bare **hex digits** with no prefix — `"ffffffffffffff"`, the test
 * dapp's `bypasses.js` case — are still refused. That string is not a
 * decimal integer, so there is no reading of it that we can defend, and
 * guessing hex would be the dangerous direction: interpreting a decimal
 * value as hex inflates it (`"1000000000000000000"` is 1 ETH as decimal
 * and 4722 ETH as hex). Decimal is both the conservative reading and the
 * intended one.
 *
 * Leading zeros are accepted even though the spec asks for the most
 * compact representation: unambiguous, common in the wild, and rejecting
 * them enforces tidiness rather than safety. A JS `number` is accepted
 * only when it is a non-negative safe integer, since anything larger has
 * already lost precision before it reached us.
 */
export function parseRpcQuantity(v: unknown): RpcParse<bigint | undefined> {
  if (isAbsent(v)) return { ok: true, value: undefined };
  if (typeof v === "bigint") {
    return v < 0n
      ? { ok: false, reason: "quantity must not be negative" }
      : { ok: true, value: v };
  }
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) {
      return {
        ok: false,
        reason: "quantity is not a safe non-negative integer",
      };
    }
    return { ok: true, value: BigInt(v) };
  }
  if (typeof v !== "string") {
    return { ok: false, reason: "quantity must be a number or string" };
  }
  const trimmed = v.trim();
  if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
    const body = trimmed.slice(2);
    // A bare `"0x"` means zero. Reading it as anything else is not
    // possible, and zero is the minimum, so accepting it cannot make a
    // transaction larger than the dApp asked for.
    if (body.length === 0) return { ok: true, value: 0n };
    if (!HEX_BODY.test(body)) {
      return { ok: false, reason: "quantity is not hex" };
    }
    return { ok: true, value: BigInt(`0x${body}`) };
  }
  // Decimal digits only. `1e3`, `0b1`, `-1` and bare hex letters all
  // fall through to the rejection below rather than being coerced by
  // `Number()`, which accepts all of them with three different meanings.
  if (/^\d+$/.test(trimmed)) {
    return { ok: true, value: BigInt(trimmed) };
  }
  return { ok: false, reason: "quantity is not a hex or decimal integer" };
}

/** EIP-2718 transaction types this wallet can faithfully build. */
export type SupportedTxType = 0 | 1 | 2;

/**
 * Transaction type: 0, 1 or 2, and **nothing else**.
 *
 * The old code accepted those three and let everything else fall
 * through to `type = 2`, so the wallet signed a plain dynamic-fee
 * transaction whenever the dApp asked for something it did not
 * recognise. That is not a lenient default, it is executing different
 * semantics than were requested:
 *
 * - `0x76` (Tempo) carries a `feeToken` we would drop, so the user pays
 *   the fee in the wrong asset
 * - `0x4` (EIP-7702) carries an `authorizationList` we would strip, so a
 *   delegation the dApp asked for silently does not happen
 * - `0x3` (EIP-4844) carries blobs we cannot attach
 *
 * Rejecting a type we cannot build is the entire point. Supporting one
 * of these later means adding it here *and* building it, together.
 */
export function parseTxType(v: unknown): RpcParse<SupportedTxType | undefined> {
  if (isAbsent(v)) return { ok: true, value: undefined };
  let n: number;
  if (typeof v === "number") {
    n = v;
  } else if (typeof v === "string") {
    const parsed = parseRpcQuantity(v);
    if (!parsed.ok)
      return { ok: false, reason: "type is not a valid quantity" };
    if (parsed.value === undefined || parsed.value > 0xffn) {
      return { ok: false, reason: "unsupported transaction type" };
    }
    n = Number(parsed.value);
  } else {
    return { ok: false, reason: "type must be a number or hex string" };
  }
  if (n === 0 || n === 1 || n === 2) return { ok: true, value: n };
  return { ok: false, reason: "unsupported transaction type" };
}
