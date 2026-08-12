/**
 * Minimal Move bytecode reader — extracts a compiled module's own name.
 *
 * A Sui `Publish` / `Upgrade` command carries compiled module *bytes*,
 * not names. Reporting "3 modules" tells a user nothing about what they
 * are publishing, so this walks just far enough into the binary format
 * to recover each module's declared name.
 *
 * Layout (move-binary-format):
 *
 *   magic  A1 1C EB 0B
 *   version                        u32 LE
 *   table_count                    ULEB128
 *   table headers × table_count    (kind u8, offset ULEB128, byteLen ULEB128)
 *   table contents                 offsets are relative to end-of-headers
 *   self_module_handle_idx         ULEB128, immediately after the contents
 *
 * The name is `IDENTIFIERS[MODULE_HANDLES[self].name]`.
 *
 * Every failure mode returns `null`. That is the point: on a signing
 * surface a mis-parsed module name is strictly worse than no name,
 * because the user would be reading a fabricated label instead of
 * treating the publish as opaque. Callers must render the count when
 * this returns null rather than substituting a placeholder.
 */

const MAGIC = [0xa1, 0x1c, 0xeb, 0x0b];
const TABLE_MODULE_HANDLES = 0x1;
const TABLE_IDENTIFIERS = 0x7;

/** Identifiers are Move source identifiers; anything else means mis-parse. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_IDENT_LEN = 128;

interface Cursor {
  bytes: Uint8Array;
  pos: number;
}

/** ULEB128, capped at 5 bytes (u32) — longer is malformed, not big. */
function uleb(c: Cursor): number | null {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    if (c.pos >= c.bytes.length) return null;
    const byte = c.bytes[c.pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result >>> 0;
    shift += 7;
  }
  return null;
}

export function readMoveModuleName(bytes: Uint8Array): string | null {
  try {
    if (bytes.length < 10) return null;
    for (let i = 0; i < MAGIC.length; i++) {
      if (bytes[i] !== MAGIC[i]) return null;
    }

    const c: Cursor = { bytes, pos: 8 }; // magic (4) + version (4)
    const tableCount = uleb(c);
    if (tableCount === null || tableCount > 64) return null;

    const tables: Array<{ kind: number; offset: number; len: number }> = [];
    for (let i = 0; i < tableCount; i++) {
      if (c.pos >= bytes.length) return null;
      const kind = bytes[c.pos++];
      const offset = uleb(c);
      const len = uleb(c);
      if (offset === null || len === null) return null;
      tables.push({ kind, offset, len });
    }

    const headerEnd = c.pos;
    let contentEnd = headerEnd;
    for (const t of tables) {
      const end = headerEnd + t.offset + t.len;
      if (end > bytes.length) return null;
      if (end > contentEnd) contentEnd = end;
    }

    const identTable = tables.find((t) => t.kind === TABLE_IDENTIFIERS);
    const handleTable = tables.find((t) => t.kind === TABLE_MODULE_HANDLES);
    if (!identTable || !handleTable) return null;

    // `self_module_handle_idx` sits immediately after the last table.
    const selfCursor: Cursor = { bytes, pos: contentEnd };
    const selfIdx = uleb(selfCursor);
    if (selfIdx === null) return null;

    // Module handles: (address_idx, name_idx) pairs.
    const hc: Cursor = { bytes, pos: headerEnd + handleTable.offset };
    const handleEnd = hc.pos + handleTable.len;
    const nameIdxs: number[] = [];
    while (hc.pos < handleEnd) {
      const addrIdx = uleb(hc);
      const nameIdx = uleb(hc);
      if (addrIdx === null || nameIdx === null) return null;
      nameIdxs.push(nameIdx);
    }
    if (hc.pos !== handleEnd) return null;
    if (selfIdx >= nameIdxs.length) return null;
    const wantIdx = nameIdxs[selfIdx];

    // Identifier pool: (len, utf8 bytes) entries.
    const ic: Cursor = { bytes, pos: headerEnd + identTable.offset };
    const identEnd = ic.pos + identTable.len;
    let index = 0;
    while (ic.pos < identEnd) {
      const len = uleb(ic);
      if (len === null || len === 0 || len > MAX_IDENT_LEN) return null;
      if (ic.pos + len > identEnd) return null;
      if (index === wantIdx) {
        const slice = bytes.subarray(ic.pos, ic.pos + len);
        let name = "";
        for (const b of slice) {
          if (b < 0x20 || b > 0x7e) return null;
          name += String.fromCharCode(b);
        }
        return IDENT.test(name) ? name : null;
      }
      ic.pos += len;
      index++;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Names for a whole publish/upgrade payload. Returns `undefined` unless
 * *every* module parsed — a partial list would silently imply the
 * missing ones don't exist.
 */
export function readMoveModuleNames(
  modules: Uint8Array[],
): string[] | undefined {
  if (modules.length === 0) return undefined;
  const names: string[] = [];
  for (const m of modules) {
    const name = readMoveModuleName(m);
    if (!name) return undefined;
    names.push(name);
  }
  return names;
}
