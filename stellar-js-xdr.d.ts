/**
 * Minimal ambient typing for `@stellar/js-xdr` — the package ships no
 * declarations. Only the `XdrReader` surface task 65's Soroban
 * contract-spec streaming decode uses is declared
 * (`services/walletKit/stellar/clearSigning.ts`): construct over the
 * `contractspecv0` custom-section bytes, then `ScSpecEntry.read(reader)`
 * until `eof`. Declared with a default export because the package is
 * CJS whose named exports Node's ESM lexer cannot statically detect.
 */
declare module "@stellar/js-xdr" {
  export class XdrReader {
    constructor(source: Buffer | Uint8Array);
    readonly eof: boolean;
  }
  const jsXdr: { XdrReader: typeof XdrReader };
  export default jsXdr;
}
