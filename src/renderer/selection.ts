/**
 * Block (rectangular) selection, as in PCOMM and other IBM emulators: drag
 * from one cell to another to select the rectangle between them; Shift-drag
 * extends the current selection from its anchor; Cmd/Ctrl+C copies it, one
 * line per row with trailing blanks trimmed. Shared by both renderers, which
 * only draw the rectangle.
 */

export interface CellPosition {
  row: number;
  col: number;
}

/** An inclusive rectangle of cells. */
export interface BlockRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** The rectangle spanned by two corner cells, in either order. */
export function blockRect(a: CellPosition, b: CellPosition): BlockRect {
  return {
    top: Math.min(a.row, b.row),
    left: Math.min(a.col, b.col),
    bottom: Math.max(a.row, b.row),
    right: Math.max(a.col, b.col),
  };
}

/**
 * The text of a rectangle: for each row, its columns `left`–`right`, trailing
 * blanks trimmed; rows joined with newlines. `lines` is the screen as text
 * (Terminal.text, where non-display fields are already blank).
 */
export function blockText(lines: readonly string[], r: BlockRect): string {
  return lines
    .slice(r.top, r.bottom + 1)
    .map((line) => line.slice(r.left, r.right + 1).trimEnd())
    .join('\n');
}

export interface BlockSelectorHost {
  /** The element mouse events arrive on. */
  readonly target: HTMLElement;
  /** The element whose copy events (bubbling from the keyboard's textarea) we answer. */
  readonly copyTarget: HTMLElement;
  cellAt(clientX: number, clientY: number): CellPosition | undefined;
  /** The screen as text, when a terminal is attached. */
  lines(): readonly string[] | undefined;
  /** The selection changed (`undefined`: cleared). Repaint `old` and `next`. */
  changed(next: BlockRect | undefined, old: BlockRect | undefined): void;
}

/** Mouse handling and copy for a block selection. */
export class BlockSelector {
  #anchor: CellPosition | undefined;
  #focus: CellPosition | undefined;
  #dragging = false;
  readonly #cleanup: (() => void)[] = [];

  constructor(readonly host: BlockSelectorHost) {
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      el.addEventListener(type, fn);
      this.#cleanup.push(() => el.removeEventListener(type, fn));
    };
    on(host.target, 'mousedown', (e) => {
      if (e.button !== 0) return;
      const cell = host.cellAt(e.clientX, e.clientY);
      if (!cell) return;
      this.#dragging = true;
      if (e.shiftKey && this.#anchor) {
        this.#select(this.#anchor, cell); // extend from the anchor
      } else {
        this.clear();
        this.#anchor = cell; // a selection starts once the mouse leaves this cell
      }
    });
    on(host.target, 'mousemove', (e) => {
      if (!this.#dragging || !this.#anchor || (e.buttons & 1) === 0) return;
      const cell = host.cellAt(e.clientX, e.clientY);
      if (!cell) return;
      if (!this.#focus && cell.row === this.#anchor.row && cell.col === this.#anchor.col) return;
      this.#select(this.#anchor, cell);
    });
    on(host.target.ownerDocument.documentElement, 'mouseup', () => (this.#dragging = false));
    on(host.copyTarget, 'copy', (e) => {
      const text = this.text;
      if (!text) return;
      e.clipboardData?.setData('text/plain', text);
      e.preventDefault();
    });
  }

  /** The selected rectangle, if any. */
  get rect(): BlockRect | undefined {
    return this.#anchor && this.#focus ? blockRect(this.#anchor, this.#focus) : undefined;
  }

  /** The selected text ('' when nothing is selected). */
  get text(): string {
    const rect = this.rect;
    const lines = this.host.lines();
    return rect && lines ? blockText(lines, rect) : '';
  }

  /** Select the rectangle between two cells, as a drag would. */
  select(from: CellPosition, to: CellPosition): void {
    this.#anchor = from;
    this.#select(from, to);
  }

  clear(): void {
    const old = this.rect;
    this.#anchor = undefined;
    this.#focus = undefined;
    if (old) this.host.changed(undefined, old);
  }

  dispose(): void {
    for (const c of this.#cleanup.splice(0)) c();
  }

  #select(anchor: CellPosition, focus: CellPosition): void {
    const old = this.rect;
    this.#anchor = anchor;
    this.#focus = focus;
    const next = this.rect!;
    if (
      !old ||
      old.top !== next.top ||
      old.left !== next.left ||
      old.bottom !== next.bottom ||
      old.right !== next.right
    ) {
      this.host.changed(next, old);
    }
  }
}
