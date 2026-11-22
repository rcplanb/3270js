/**
 * Field and extended attributes. GA23-0059 §4 ("Field and Extended Field
 * Attributes") and §4.4 ("Character Attributes").
 */

/** Bits of the 3270 field attribute byte (bit 0 is the high-order bit). */
export const FieldAttribute = {
  /** Bit 2: protected. */
  PROTECTED: 0x20,
  /** Bit 3: numeric. With PROTECTED, the field is auto-skip. */
  NUMERIC: 0x10,
  /** Bits 4–5: display and light-pen detection. */
  DISPLAY_MASK: 0x0c,
  /** B'00': normal intensity, not detectable. */
  DISPLAY_NORMAL: 0x00,
  /** B'01': normal intensity, detectable. */
  DISPLAY_NORMAL_DETECTABLE: 0x04,
  /** B'10': intensified, detectable. */
  DISPLAY_INTENSIFIED: 0x08,
  /** B'11': non-display, not detectable. */
  DISPLAY_HIDDEN: 0x0c,
  /** Bit 7: modified data tag. */
  MDT: 0x01,
  /** The bits that carry meaning; bits 0–1 only make the byte a graphic character. */
  MEANINGFUL: 0x3d,
} as const;

export type DisplayMode = 'normal' | 'intensified' | 'hidden';

export interface FieldAttributeInfo {
  protected: boolean;
  numeric: boolean;
  /** Protected and numeric: the cursor skips over this field. */
  autoskip: boolean;
  display: DisplayMode;
  /** Light-pen detectable (stored, not otherwise used). */
  detectable: boolean;
  modified: boolean;
}

export function decodeFieldAttribute(fa: number): FieldAttributeInfo {
  const d = fa & FieldAttribute.DISPLAY_MASK;
  const prot = (fa & FieldAttribute.PROTECTED) !== 0;
  const num = (fa & FieldAttribute.NUMERIC) !== 0;
  return {
    protected: prot,
    numeric: num,
    autoskip: prot && num,
    display:
      d === FieldAttribute.DISPLAY_HIDDEN
        ? 'hidden'
        : d === FieldAttribute.DISPLAY_INTENSIFIED
          ? 'intensified'
          : 'normal',
    detectable:
      d === FieldAttribute.DISPLAY_NORMAL_DETECTABLE || d === FieldAttribute.DISPLAY_INTENSIFIED,
    modified: (fa & FieldAttribute.MDT) !== 0,
  };
}

/** Extended attribute type codes, as used by SFE, SA and MF. GA23-0059 §4.4.5. */
export const AttributeType = {
  /** Reset all character attributes (SA only). */
  ALL: 0x00,
  FIELD_ATTRIBUTE: 0xc0,
  VALIDATION: 0xc1,
  OUTLINING: 0xc2,
  HIGHLIGHTING: 0x41,
  FOREGROUND: 0x42,
  CHARSET: 0x43,
  BACKGROUND: 0x45,
  TRANSPARENCY: 0x46,
} as const;

/** Highlighting values (type X'41'). X'00' means "use the field's value". */
export const Highlighting = {
  DEFAULT: 0x00,
  NORMAL: 0xf0,
  BLINK: 0xf1,
  REVERSE: 0xf2,
  UNDERSCORE: 0xf4,
  INTENSIFY: 0xf8,
} as const;

/** Colour values (types X'42' and X'45'). X'00' means "use the default". */
export const Color = {
  DEFAULT: 0x00,
  NEUTRAL_BLACK: 0xf0,
  BLUE: 0xf1,
  RED: 0xf2,
  PINK: 0xf3,
  GREEN: 0xf4,
  TURQUOISE: 0xf5,
  YELLOW: 0xf6,
  NEUTRAL_WHITE: 0xf7,
} as const;

/** Character set values (type X'43'). X'F1' selects the APL/graphic-escape set. */
export const CharacterSet = {
  DEFAULT: 0x00,
  APL: 0xf1,
} as const;

/**
 * Extended attributes of one cell. On a field attribute cell they are the
 * field's attributes (from SFE/MF); on a character cell they are that
 * character's own attributes (from SA), where 0 means "inherit from the field".
 * Values are stored raw; renderers interpret them.
 */
export interface CellAttributes {
  foreground: number;
  background: number;
  highlighting: number;
  charset: number;
  transparency: number;
}

/** Field-only extended attributes. */
export interface FieldExtendedAttributes extends CellAttributes {
  validation: number;
  outlining: number;
}

export const DEFAULT_CELL_ATTRIBUTES: Readonly<CellAttributes> = Object.freeze({
  foreground: 0,
  background: 0,
  highlighting: 0,
  charset: 0,
  transparency: 0,
});
