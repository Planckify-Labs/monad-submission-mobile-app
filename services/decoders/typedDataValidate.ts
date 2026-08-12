/**
 * EIP-712 structural validation and address coercion — spec phase O.
 *
 * `eth_signTypedData_v4` used to reach the approval sheet through a
 * cast: the adapter checked the signer address, stamped the resolved
 * chain, then wrote `typedData as EvmSignTypedDataPayload["typedData"]`
 * with no structural check at all. `MetaMask/test-dapp`'s
 * `malformed-signatures.js` supplies six payloads that walk straight
 * through that, and `bypasses.js` two more.
 *
 * Two distinct problems, and they deserve different fixes.
 *
 * ### The malformed six are not fund-loss bugs
 *
 * `domain: {}`, `primaryType: 'Non-Existent'`, a type referencing
 * `'ConsiderationItem[+'`, a missing `primaryType`: viem throws on all
 * of them at sign time, so nothing gets signed. What they cost is
 * **approve-then-fail** — the user reads a sheet, taps approve, and gets
 * an error. Do that often enough and rejection stops meaning anything.
 * Catching them at the boundary means no sheet opens, which is the
 * honest outcome for a request that was never signable.
 *
 * ### Two of them are display bugs, which is worse
 *
 * `signExtraDataNotTyped` puts a key in `message` that is absent from
 * `types`. Since the sheet renders `message` keys directly, we would
 * display a field that **is not in the signed hash** — the user reads
 * one thing and signs another. The fix is to render from `types`, not
 * from `message`, and to say so when the two disagree.
 *
 * `maliciousPermitIntAddress` sends `verifyingContract` as the decimal
 * string `"917551056842671309452305380979543736893630245704"`, which is
 * `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` — **real USDC**. Every
 * address-keyed lookup we have misses, so the user sees a 48-digit
 * number where a token name belongs.
 *
 * ### Why coercing addresses here is safe, when repairing calldata was not
 *
 * Phase M refuses to left-pad odd calldata because doing so guesses at
 * what a node would do with bytes that are not bytes. Here there is no
 * guess: the EIP-712 type system states that the field **is** an
 * `address`, and a decimal integer under 2^160 has exactly one reading
 * as one. We are applying a declared type, not inferring an undeclared
 * one.
 */

import { getAddress, isAddress } from "viem";

export interface TypedDataField {
  name: string;
  type: string;
}

export interface TypedDataShape {
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

export type TypedDataValidation =
  | {
      ok: true;
      value: TypedDataShape;
      /**
       * Keys present in `message` but absent from `types[primaryType]`.
       * Not a rejection: they are not part of the signed hash, so they
       * are harmless to sign and dangerous only to *display*. The sheet
       * warns and does not render them.
       */
      undeclaredKeys: string[];
    }
  | { ok: false; reason: string };

/** Solidity elementary types that need no entry in `types`. */
const ELEMENTARY =
  /^(address|bool|string|bytes|uint(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?|int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?|bytes([1-9]|[12][0-9]|3[0-2]))$/;

/** `Foo[]`, `Foo[3]` and `Foo` all resolve to the struct `Foo`. */
const ARRAY_SUFFIX = /^(.+?)((\[\d*\])+)$/;

function baseType(type: string): string | null {
  const m = ARRAY_SUFFIX.exec(type);
  if (!m) return type;
  // Reject a malformed suffix outright rather than salvaging a prefix.
  // `ConsiderationItem[+` matches nothing here and returns null, which
  // is the intended outcome: an unparseable type is not a type.
  return m[1];
}

function isWellFormedTypeName(type: string): boolean {
  // A struct name, optionally followed by well-formed array suffixes.
  return /^[A-Za-z_$][A-Za-z0-9_$]*((\[\d*\])*)$/.test(type);
}

const UINT160_MAX = (1n << 160n) - 1n;

/**
 * Coerce a value the type system says is an `address` into checksummed
 * hex. Returns `null` when it is not recognisably an address, so the
 * caller can reject rather than invent one.
 */
export function coerceAddress(value: unknown): `0x${string}` | null {
  if (typeof value === "bigint") {
    return value >= 0n && value <= UINT160_MAX
      ? getAddress(`0x${value.toString(16).padStart(40, "0")}`)
      : null;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return getAddress(`0x${value.toString(16).padStart(40, "0")}`);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (isAddress(trimmed)) return getAddress(trimmed);
  // The decimal form. `maliciousPermitIntAddress` is exactly this.
  if (/^\d+$/.test(trimmed)) {
    const n = BigInt(trimmed);
    return n <= UINT160_MAX
      ? getAddress(`0x${n.toString(16).padStart(40, "0")}`)
      : null;
  }
  return null;
}

/**
 * Strict `chainId` parse. `Number()` accepts `"1e3"`, `" 1 "`, `"0x1"`
 * and `""` with three different intents and one silent surprise, so it
 * is not a parser and must not be used as one.
 */
export function coerceChainId(value: unknown): number | null {
  if (typeof value === "bigint") {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : null;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // A 64-digit hex-padded chainId is one of the test-dapp's cases;
  // it is well-formed, just verbose.
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    const n = BigInt(trimmed);
    return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
  }
  if (/^\d+$/.test(trimmed)) {
    const n = BigInt(trimmed);
    return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
  }
  return null;
}

/**
 * Walk a value against its declared type, coercing every `address`
 * field. Returns `null` on a structural mismatch the signer would
 * otherwise discover only at sign time.
 */
function normalizeValue(
  value: unknown,
  type: string,
  types: Record<string, TypedDataField[]>,
  depth: number,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (depth > 12) return { ok: false, reason: "type nesting too deep" };

  const arrayMatch = ARRAY_SUFFIX.exec(type);
  if (arrayMatch) {
    if (!Array.isArray(value)) {
      return { ok: false, reason: `expected an array for ${type}` };
    }
    // Strip one dimension at a time so `Foo[][2]` resolves correctly.
    const inner = type.slice(0, type.lastIndexOf("["));
    const out: unknown[] = [];
    for (const item of value) {
      const r = normalizeValue(item, inner, types, depth + 1);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }

  if (type === "address") {
    const address = coerceAddress(value);
    return address === null
      ? { ok: false, reason: "value declared address is not one" }
      : { ok: true, value: address };
  }

  if (ELEMENTARY.test(type)) return { ok: true, value };

  const struct = types[type];
  if (!struct) return { ok: false, reason: `unknown type ${type}` };
  if (value === null || typeof value !== "object") {
    return { ok: false, reason: `expected an object for ${type}` };
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of struct) {
    // A declared field with no value is a sign-time throw waiting to
    // happen, which is exactly the approve-then-fail this phase exists
    // to stop. Inventing a zero instead would be worse: it changes what
    // gets signed to something nobody asked for.
    if (!(field.name in source)) {
      return { ok: false, reason: `${type}.${field.name} is missing` };
    }
    const r = normalizeValue(source[field.name], field.type, types, depth + 1);
    if (!r.ok) return r;
    out[field.name] = r.value;
  }
  return { ok: true, value: out };
}

/**
 * Validate and normalise a dApp-supplied typed-data payload.
 *
 * Rejection here means no approval sheet is raised at all, which is the
 * point: a structurally invalid payload cannot be signed, so asking the
 * user about it only teaches them that rejection is routine.
 */
export function validateTypedData(raw: unknown): TypedDataValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "typed data is not an object" };
  }
  const td = raw as Record<string, unknown>;

  const types = td.types;
  if (!types || typeof types !== "object" || Array.isArray(types)) {
    return { ok: false, reason: "types is missing" };
  }
  const typeMap: Record<string, TypedDataField[]> = {};
  for (const [name, fields] of Object.entries(
    types as Record<string, unknown>,
  )) {
    if (!Array.isArray(fields)) {
      return { ok: false, reason: `type ${name} is not a field list` };
    }
    const parsed: TypedDataField[] = [];
    for (const f of fields) {
      if (
        !f ||
        typeof f !== "object" ||
        typeof (f as TypedDataField).name !== "string" ||
        typeof (f as TypedDataField).type !== "string"
      ) {
        return { ok: false, reason: `type ${name} has a malformed field` };
      }
      const field = f as TypedDataField;
      if (!isWellFormedTypeName(field.type) && !ELEMENTARY.test(field.type)) {
        // `'ConsiderationItem[+'` lands here.
        return { ok: false, reason: `unparseable type ${field.type}` };
      }
      parsed.push({ name: field.name, type: field.type });
    }
    typeMap[name] = parsed;
  }

  const primaryType = td.primaryType;
  if (typeof primaryType !== "string" || primaryType === "") {
    return { ok: false, reason: "primaryType is missing" };
  }
  if (!typeMap[primaryType]) {
    return { ok: false, reason: "primaryType is not declared in types" };
  }

  // Every referenced struct must resolve. A dangling reference is a
  // sign-time throw waiting to happen.
  const seen = new Set<string>();
  const queue = [primaryType];
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const field of typeMap[name] ?? []) {
      const base = baseType(field.type);
      if (base === null) {
        return { ok: false, reason: `unparseable type ${field.type}` };
      }
      if (ELEMENTARY.test(base)) continue;
      if (!typeMap[base]) {
        return { ok: false, reason: `unknown type ${base}` };
      }
      queue.push(base);
    }
  }

  const domain = td.domain;
  if (!domain || typeof domain !== "object" || Array.isArray(domain)) {
    return { ok: false, reason: "domain is missing" };
  }
  const domainOut: Record<string, unknown> = { ...(domain as object) };
  if ("verifyingContract" in domainOut) {
    const address = coerceAddress(domainOut.verifyingContract);
    if (address === null) {
      return { ok: false, reason: "verifyingContract is not an address" };
    }
    domainOut.verifyingContract = address;
  }
  if ("chainId" in domainOut && domainOut.chainId !== undefined) {
    const chainId = coerceChainId(domainOut.chainId);
    if (chainId === null) return { ok: false, reason: "chainId is not valid" };
    domainOut.chainId = chainId;
  }
  if ("salt" in domainOut && typeof domainOut.salt === "string") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(domainOut.salt)) {
      return { ok: false, reason: "salt is not a bytes32" };
    }
  }

  const message = td.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, reason: "message is missing" };
  }

  const declared = new Set(typeMap[primaryType].map((f) => f.name));
  const undeclaredKeys = Object.keys(message as object).filter(
    (k) => !declared.has(k),
  );

  const normalized = normalizeValue(message, primaryType, typeMap, 0);
  if (!normalized.ok) return { ok: false, reason: normalized.reason };

  return {
    ok: true,
    value: {
      types: typeMap,
      primaryType,
      domain: domainOut,
      // Only declared fields survive. This is the display/sign fix:
      // whatever the sheet renders from here is, by construction, what
      // goes into the hash.
      message: normalized.value as Record<string, unknown>,
    },
    undeclaredKeys,
  };
}
