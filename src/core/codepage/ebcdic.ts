/**
 * EBCDIC values with special meaning in the 3270 buffer. These are the same in
 * every EBCDIC code page. GA23-0059 §3.2 (Character Sets and Control Codes).
 *
 * How each one is displayed (e.g. DUP as an overscored asterisk) is renderer
 * policy, handled in src/renderer.
 */
export const Ebcdic = {
  /** Null: displayed as a blank; suppressed in Read Modified. */
  NUL: 0x00,
  /** Form Feed. */
  FF: 0x0c,
  /** Carriage Return. */
  CR: 0x0d,
  /** New Line. */
  NL: 0x15,
  /** End of Medium. */
  EM: 0x19,
  /** Duplicate: entered by the DUP key. */
  DUP: 0x1c,
  /** Field Mark: entered by the FIELD MARK key. */
  FM: 0x1e,
  /** Substitute. */
  SUB: 0x3f,
  /** Space. */
  SPACE: 0x40,
  /** Eight Ones. */
  EO: 0xff,
} as const;

/** True for the displayable character range X'40'–X'FE'. */
export function isGraphic(byte: number): boolean {
  return byte >= 0x40 && byte <= 0xfe;
}
