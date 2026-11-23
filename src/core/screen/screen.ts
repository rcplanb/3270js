/**
 * The 3270 display buffer: one cell per screen position, each holding either a
 * character or a field attribute, plus extended attributes.
 *
 * This is pure state. The data stream and keyboard decide *what* to change;
 * the screen only stores it, derives the field list, and records which rows
 * changed so renderers can repaint just those.
 */
import type { CodePage } from '../codepage/index.js';
import { displayChar } from '../codepage/index.js';
import { isValidAddress } from './address.js';
import {
  type CellAttributes,
  type DisplayMode,
  type FieldAttributeInfo,
  type FieldExtendedAttributes,
  FieldAttribute,
  decodeFieldAttribute,
} from './attributes.js';

/** Standard 3278/3279 screen sizes by model number. */
export const MODELS = Object.freeze({
  2: Object.freeze({ rows: 24, cols: 80 }),
  3: Object.freeze({ rows: 32, cols: 80 }),
  4: Object.freeze({ rows: 43, cols: 80 }),
  5: Object.freeze({ rows: 27, cols: 132 }),
});
export type ModelNumber = keyof typeof MODELS;

/** A field: its attribute cell plus the data cells up to the next attribute. */
export interface Field extends FieldAttributeInfo, FieldExtendedAttributes {
  /** Index in `Screen.fields`. */
  index: number;
  /** Address of the field attribute cell. */
  start: number;
  /** Address of the first data cell (wraps). */
  dataStart: number;
  /** Number of data cells (may be 0). */
  length: number;
  /** The stored field attribute byte (meaningful bits only). */
  attribute: number;
}

export interface ToTextOptions {
  /** Show the contents of non-display fields. Default false. */
  showHidden?: boolean;
}

const NO_FIELD = -1;

export class Screen {
  #rows = 0;
  #cols = 0;
  #size = 0;
  #cursor = 0;
  #version = 0;

  // One entry per cell.
  #chars = new Uint8Array(0);
  #isFa = new Uint8Array(0);
  #fa = new Uint8Array(0);
  #fg = new Uint8Array(0);
  #bg = new Uint8Array(0);
  #hl = new Uint8Array(0);
  #cs = new Uint8Array(0);
  #tr = new Uint8Array(0);
  #validation = new Uint8Array(0);
  #outlining = new Uint8Array(0);
  #dirtyRows = new Uint8Array(0);

  // Derived; rebuilt lazily after field attributes change.
  #fieldsStale = true;
  #fields: Field[] = [];
  #owner = new Int32Array(0);

  constructor(rows: number, cols: number) {
    this.resize(rows, cols);
  }

  get rows(): number {
    return this.#rows;
  }
  get cols(): number {
    return this.#cols;
  }
  get size(): number {
    return this.#size;
  }
  /** Increases on every change; cheap change detection for observers. */
  get version(): number {
    return this.#version;
  }

  get cursor(): number {
    return this.#cursor;
  }
  set cursor(address: number) {
    this.#check(address);
    if (address !== this.#cursor) {
      this.#markRow(this.#cursor);
      this.#markRow(address);
      this.#cursor = address;
      this.#version++;
    }
  }

  /** Change geometry (e.g. for Erase/Write Alternate) and clear. */
  resize(rows: number, cols: number): void {
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
      throw new RangeError(`invalid screen size ${rows}x${cols}`);
    }
    this.#rows = rows;
    this.#cols = cols;
    this.#size = rows * cols;
    const n = this.#size;
    this.#chars = new Uint8Array(n);
    this.#isFa = new Uint8Array(n);
    this.#fa = new Uint8Array(n);
    this.#fg = new Uint8Array(n);
    this.#bg = new Uint8Array(n);
    this.#hl = new Uint8Array(n);
    this.#cs = new Uint8Array(n);
    this.#tr = new Uint8Array(n);
    this.#validation = new Uint8Array(n);
    this.#outlining = new Uint8Array(n);
    this.#dirtyRows = new Uint8Array(rows).fill(1);
    this.#owner = new Int32Array(n);
    this.#cursor = 0;
    this.#fieldsStale = true;
    this.#version++;
  }

  /**
   * Make this screen an exact copy of `other`: size, every cell and its
   * attributes, the fields and the cursor. Used to continue a session from a
   * copy kept elsewhere (Terminal.adopt).
   */
  copyFrom(other: Screen): void {
    if (other.#rows !== this.#rows || other.#cols !== this.#cols)
      this.resize(other.#rows, other.#cols);
    this.#chars.set(other.#chars);
    this.#isFa.set(other.#isFa);
    this.#fa.set(other.#fa);
    this.#fg.set(other.#fg);
    this.#bg.set(other.#bg);
    this.#hl.set(other.#hl);
    this.#cs.set(other.#cs);
    this.#tr.set(other.#tr);
    this.#validation.set(other.#validation);
    this.#outlining.set(other.#outlining);
    this.#cursor = other.#cursor;
    this.#fieldsChanged();
    this.#version++;
  }

  /** Erase every cell to null with default attributes and home the cursor. */
  clear(): void {
    for (const a of [
      this.#chars,
      this.#isFa,
      this.#fa,
      this.#fg,
      this.#bg,
      this.#hl,
      this.#cs,
      this.#tr,
      this.#validation,
      this.#outlining,
    ]) {
      a.fill(0);
    }
    this.#dirtyRows.fill(1);
    this.#cursor = 0;
    this.#fieldsStale = true;
    this.#version++;
  }

  charAt(address: number): number {
    this.#check(address);
    return this.#chars[address]!;
  }

  isFieldAttribute(address: number): boolean {
    this.#check(address);
    return this.#isFa[address] === 1;
  }

  /** The field attribute byte at `address`, or undefined if it holds a character. */
  fieldAttributeAt(address: number): number | undefined {
    return this.isFieldAttribute(address) ? this.#fa[address] : undefined;
  }

  /** The extended attributes stored on this cell (field-level for attribute cells). */
  attributesAt(address: number): CellAttributes {
    this.#check(address);
    return {
      foreground: this.#fg[address]!,
      background: this.#bg[address]!,
      highlighting: this.#hl[address]!,
      charset: this.#cs[address]!,
      transparency: this.#tr[address]!,
    };
  }

  /**
   * Store a character. Attributes not given are reset to 0 ("inherit from the
   * field"). Overwriting a field attribute cell removes that field.
   */
  writeChar(address: number, byte: number, attrs: Partial<CellAttributes> = {}): void {
    this.#check(address);
    if (this.#isFa[address]) {
      this.#isFa[address] = 0;
      this.#fa[address] = 0;
      this.#validation[address] = 0;
      this.#outlining[address] = 0;
      this.#fieldsChanged();
    }
    this.#chars[address] = byte;
    this.#setCellAttrs(address, attrs);
    this.#markRow(address);
    this.#version++;
  }

  /**
   * Store a character but keep the cell's colour, background, highlighting and
   * transparency (the character set is reset). This is how erase operations
   * (EUA, EAU, Erase EOF) null cells, matching x3270.
   */
  replaceChar(address: number, byte: number): void {
    const attrs = this.attributesAt(address);
    this.writeChar(address, byte, { ...attrs, charset: 0 });
  }

  /**
   * Change some attributes of an existing field (Modify Field). Attributes not
   * given keep their current values.
   */
  modifyField(
    address: number,
    changes: Partial<FieldExtendedAttributes> & { attribute?: number },
  ): void {
    if (!this.isFieldAttribute(address)) {
      throw new Error(`address ${address} is not a field attribute`);
    }
    if (changes.attribute !== undefined) {
      this.#fa[address] = changes.attribute & FieldAttribute.MEANINGFUL;
    }
    if (changes.foreground !== undefined) this.#fg[address] = changes.foreground;
    if (changes.background !== undefined) this.#bg[address] = changes.background;
    if (changes.highlighting !== undefined) this.#hl[address] = changes.highlighting;
    if (changes.charset !== undefined) this.#cs[address] = changes.charset;
    if (changes.transparency !== undefined) this.#tr[address] = changes.transparency;
    if (changes.validation !== undefined) this.#validation[address] = changes.validation;
    if (changes.outlining !== undefined) this.#outlining[address] = changes.outlining;
    this.#fieldsChanged();
    this.#version++;
  }

  /** Make `address` a field attribute cell (Start Field / Start Field Extended). */
  startField(address: number, attribute: number, ext: Partial<FieldExtendedAttributes> = {}): void {
    this.#check(address);
    this.#isFa[address] = 1;
    this.#fa[address] = attribute & FieldAttribute.MEANINGFUL;
    this.#chars[address] = 0;
    this.#setCellAttrs(address, ext);
    this.#validation[address] = ext.validation ?? 0;
    this.#outlining[address] = ext.outlining ?? 0;
    this.#fieldsChanged();
    this.#version++;
  }

  /** Set or clear the modified data tag of the field whose attribute is at `faAddress`. */
  setModified(faAddress: number, modified: boolean): void {
    if (!this.isFieldAttribute(faAddress)) {
      throw new Error(`address ${faAddress} is not a field attribute`);
    }
    const old = this.#fa[faAddress]!;
    const next = modified ? old | FieldAttribute.MDT : old & ~FieldAttribute.MDT;
    if (next !== old) {
      this.#fa[faAddress] = next;
      this.#fieldsStale = true; // layout unchanged; only the Field snapshots
      this.#version++;
    }
  }

  /** Clear every modified data tag (WCC "reset MDT"). */
  resetModified(): void {
    let changed = false;
    for (let a = 0; a < this.#size; a++) {
      if (this.#isFa[a] && this.#fa[a]! & FieldAttribute.MDT) {
        this.#fa[a] = this.#fa[a]! & ~FieldAttribute.MDT;
        changed = true;
      }
    }
    if (changed) {
      this.#fieldsStale = true;
      this.#version++;
    }
  }

  /** True when the buffer has at least one field attribute. */
  get isFormatted(): boolean {
    return this.fields.length > 0;
  }

  /** Fields in buffer order, starting with the lowest attribute address. */
  get fields(): readonly Field[] {
    if (this.#fieldsStale) this.#rebuildFields();
    return this.#fields;
  }

  /**
   * The field containing `address` (for an attribute cell, the field it
   * starts), or undefined on an unformatted screen.
   */
  fieldAt(address: number): Field | undefined {
    this.#check(address);
    const fields = this.fields; // ensures #owner is current
    const owner = this.#owner[address]!;
    return owner === NO_FIELD ? undefined : fields[owner];
  }

  /** Rows changed since the last call, ascending. */
  takeDirtyRows(): number[] {
    const out: number[] = [];
    for (let r = 0; r < this.#rows; r++) {
      if (this.#dirtyRows[r]) {
        out.push(r);
        this.#dirtyRows[r] = 0;
      }
    }
    return out;
  }

  /** The screen as text, one string per row. For tests, logs and screen readers. */
  toText(codePage: CodePage, options: ToTextOptions = {}): string[] {
    const lines: string[] = [];
    for (let r = 0; r < this.#rows; r++) {
      let line = '';
      for (let c = 0; c < this.#cols; c++) {
        const a = r * this.#cols + c;
        const byte = this.#chars[a]!;
        const hidden = !options.showHidden && this.#displayAt(a) === 'hidden';
        line += this.#isFa[a] || hidden ? ' ' : (displayChar(byte, this.#cs[a]!, codePage) ?? ' ');
      }
      lines.push(line);
    }
    return lines;
  }

  #displayAt(address: number): DisplayMode | undefined {
    return this.fieldAt(address)?.display;
  }

  #setCellAttrs(address: number, attrs: Partial<CellAttributes>): void {
    this.#fg[address] = attrs.foreground ?? 0;
    this.#bg[address] = attrs.background ?? 0;
    this.#hl[address] = attrs.highlighting ?? 0;
    this.#cs[address] = attrs.charset ?? 0;
    this.#tr[address] = attrs.transparency ?? 0;
  }

  #fieldsChanged(): void {
    this.#fieldsStale = true;
    this.#dirtyRows.fill(1);
  }

  #markRow(address: number): void {
    this.#dirtyRows[Math.floor(address / this.#cols)] = 1;
  }

  #check(address: number): void {
    if (!isValidAddress(address, this.#size)) {
      throw new RangeError(`address ${address} outside buffer of ${this.#size}`);
    }
  }

  #rebuildFields(): void {
    const size = this.#size;
    const starts: number[] = [];
    for (let a = 0; a < size; a++) if (this.#isFa[a]) starts.push(a);

    this.#fields = starts.map((start, index) => {
      const next = starts[(index + 1) % starts.length]!;
      const length = starts.length === 1 ? size - 1 : (next - start - 1 + size) % size;
      const attribute = this.#fa[start]!;
      return {
        index,
        start,
        dataStart: (start + 1) % size,
        length,
        attribute,
        ...decodeFieldAttribute(attribute),
        foreground: this.#fg[start]!,
        background: this.#bg[start]!,
        highlighting: this.#hl[start]!,
        charset: this.#cs[start]!,
        transparency: this.#tr[start]!,
        validation: this.#validation[start]!,
        outlining: this.#outlining[start]!,
      };
    });

    if (starts.length === 0) {
      this.#owner.fill(NO_FIELD);
    } else {
      // Walk once from the first attribute, wrapping, assigning each cell to
      // the most recent attribute.
      let current = starts.length - 1; // cells before the first FA belong to the last field
      let next = 0;
      for (let a = 0; a < size; a++) {
        if (next < starts.length && a === starts[next]) {
          current = next;
          next++;
        }
        this.#owner[a] = current;
      }
    }
    this.#fieldsStale = false;
  }
}
