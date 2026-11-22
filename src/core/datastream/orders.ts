/** Outbound 3270 orders. GA23-0059 §4.3. */
export const Order = {
  /** Program Tab. */
  PT: 0x05,
  /** Graphic Escape: next byte is from the APL/alternate set. */
  GE: 0x08,
  /** Set Buffer Address (+2 address bytes). */
  SBA: 0x11,
  /** Erase Unprotected to Address (+2 address bytes). */
  EUA: 0x12,
  /** Insert Cursor. */
  IC: 0x13,
  /** Start Field (+1 attribute byte). */
  SF: 0x1d,
  /** Set Attribute (+type, value). */
  SA: 0x28,
  /** Start Field Extended (+count, count × (type, value)). */
  SFE: 0x29,
  /** Modify Field (+count, count × (type, value)). */
  MF: 0x2c,
  /** Repeat to Address (+2 address bytes, character [GE char]). */
  RA: 0x3c,
} as const;

/**
 * Format control characters: stored in the buffer like data. GA23-0059
 * §4.3.1. NUL is handled separately because it affects Program Tab.
 */
export const FORMAT_CONTROLS: ReadonlySet<number> = new Set([
  0x0c, // FF
  0x0d, // CR
  0x15, // NL
  0x19, // EM
  0x1c, // DUP
  0x1e, // FM
  0x25, // LF
  0x3f, // SUB
  0xff, // EO
]);
