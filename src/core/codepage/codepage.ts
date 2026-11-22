/** A single-byte EBCDIC code page: a bijection between byte values and Unicode characters. */
export interface CodePage {
  /** Canonical lower-case id, e.g. `cp037`. */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** Other names this code page answers to (lower-case). */
  readonly aliases: readonly string[];
  /** Map one EBCDIC byte (0–255) to a Unicode character. */
  toUnicode(byte: number): string;
  /** Map one Unicode character to its EBCDIC byte, or `undefined` if the code page lacks it. */
  fromUnicode(char: string): number | undefined;
  /** Decode a byte sequence. */
  decode(bytes: Uint8Array): string;
  /** Encode a string. Throws `RangeError` naming the first character the code page lacks. */
  encode(text: string): Uint8Array;
}

export interface CodePageDefinition {
  id: string;
  name: string;
  aliases?: readonly string[];
  /** Exactly 256 distinct UTF-16 code units; index = EBCDIC byte value. */
  table: string;
}

export function createCodePage(def: CodePageDefinition): CodePage {
  const { table } = def;
  if (table.length !== 256) {
    throw new Error(`code page ${def.id}: table must have 256 entries, got ${table.length}`);
  }
  const reverse = new Map<string, number>();
  for (let b = 0; b < 256; b++) {
    const ch = table.charAt(b);
    if (reverse.has(ch)) {
      throw new Error(`code page ${def.id}: duplicate mapping for U+${hex4(ch)}`);
    }
    reverse.set(ch, b);
  }

  const toUnicode = (byte: number): string => {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new RangeError(`not a byte: ${byte}`);
    }
    return table.charAt(byte);
  };
  const fromUnicode = (char: string): number | undefined =>
    char.length === 1 ? reverse.get(char) : undefined;

  return Object.freeze({
    id: def.id.toLowerCase(),
    name: def.name,
    aliases: Object.freeze((def.aliases ?? []).map((a) => a.toLowerCase())),
    toUnicode,
    fromUnicode,
    decode(bytes: Uint8Array): string {
      let out = '';
      for (const b of bytes) out += table.charAt(b);
      return out;
    },
    encode(text: string): Uint8Array {
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) {
        const ch = text.charAt(i);
        const b = reverse.get(ch);
        if (b === undefined) {
          throw new RangeError(
            `code page ${def.id} has no mapping for U+${hex4(ch)} at index ${i}`,
          );
        }
        out[i] = b;
      }
      return out;
    },
  });
}

function hex4(ch: string): string {
  return ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
}
