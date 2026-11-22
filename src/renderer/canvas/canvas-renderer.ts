/**
 * CanvasRenderer: draws a Terminal on a <canvas>. Characters are placed on an
 * exact cell grid (so font advance widths can't drift), the status line uses
 * the same x3270 glyph paths as the DOM renderer, and only changed rows are
 * repainted. Text selection is drawn as an overlay; Cmd/Ctrl+C copies it.
 */
import type { OiaState } from '../../core/oia/index.js';
import type { Terminal } from '../../core/terminal.js';
import { type DisplayMode, rowRuns, OUTLINE } from '../cell-style.js';
import { DOM_CSS } from '../dom/styles.js';
import { OIA_GLYPHS, OIA_GLYPH_SIZE, type OiaGlyph } from '../oia-glyphs.js';
import { oiaCells, oiaDescription } from '../oia-layout.js';
import type { CellMetrics, Renderer, RendererOptions } from '../renderer.js';
import { DEFAULT_THEME, type Theme } from '../theme.js';

export interface CanvasRendererOptions extends RendererOptions {
  /** CSS pixels. Default 16. */
  fontSize?: number;
  /** Line height as a multiple of the font size. Default 1.25. */
  lineHeight?: number;
  /** Device pixel ratio; default window.devicePixelRatio. */
  pixelRatio?: number;
}

interface Selection {
  /** Inclusive cell coordinates, normalised so a <= b. */
  a: { row: number; col: number };
  b: { row: number; col: number };
}

const BLINK_MS = 600;

export class CanvasRenderer implements Renderer {
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly #doc: Document;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #theme: Theme;
  readonly #options: CanvasRendererOptions;
  readonly #liveEl: HTMLElement;
  readonly #oiaTextEl: HTMLElement;
  #cw = 0;
  #ch = 0;
  #rows = 0;
  #cols = 0;
  #dpr = 1;
  #displayMode: DisplayMode | undefined;
  #term: Terminal | undefined;
  #unsubscribe: (() => void)[] = [];
  #shift = false;
  #blinkOn = true;
  #blinkTimer: ReturnType<typeof setInterval> | undefined;
  #blinkRows = new Set<number>();
  #cursorRow = -1;
  #selection: Selection | undefined;
  #dragFrom: { row: number; col: number } | undefined;
  #listeners: (() => void)[] = [];

  constructor(container: HTMLElement, options: CanvasRendererOptions = {}) {
    this.#doc = container.ownerDocument;
    this.#options = options;
    this.#theme = options.theme ?? DEFAULT_THEME;
    this.#displayMode = options.displayMode;
    injectStyles(this.#doc);

    this.element = this.#doc.createElement('div');
    this.element.className = 't3270 t3270-canvas';
    this.element.tabIndex = 0;
    this.element.setAttribute('role', 'application');
    this.element.setAttribute('aria-label', 'IBM 3270 terminal');
    this.element.setAttribute('aria-roledescription', 'terminal');
    this.element.style.backgroundColor = this.#theme.colors.background;

    this.canvas = this.#doc.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.display = 'block';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('CanvasRenderer: 2D canvas is not available');
    this.#ctx = ctx;

    this.#oiaTextEl = this.#doc.createElement('div');
    this.#oiaTextEl.className = 't3270-sr-only';
    this.#liveEl = this.#doc.createElement('div');
    this.#liveEl.className = 't3270-sr-only';
    this.#liveEl.setAttribute('aria-live', 'polite');
    this.#liveEl.setAttribute('aria-atomic', 'true');

    this.element.append(this.canvas, this.#oiaTextEl, this.#liveEl);
    container.append(this.element);
    this.#listen();
  }

  get cellMetrics(): CellMetrics | undefined {
    return this.#cw ? { width: this.#cw, height: this.#ch } : undefined;
  }

  attach(terminal: Terminal): void {
    this.detach();
    this.#term = terminal;
    this.#unsubscribe = [
      terminal.on('render', () => this.#paintDirty()),
      terminal.on('oia', (s) => this.#paintOia(s)),
      terminal.on('screenSettled', () => this.#announce()),
    ];
    this.refresh();
  }

  detach(): void {
    for (const u of this.#unsubscribe) u();
    this.#unsubscribe = [];
    this.#term = undefined;
    this.#stopBlink();
  }

  refresh(): void {
    const term = this.#term;
    if (!term) return;
    this.#layout();
    term.screen.takeDirtyRows();
    this.#blinkRows.clear();
    for (let r = 0; r < this.#rows; r++) this.#paintRow(r);
    this.#paintCursor();
    this.#paintOia(term.oia.state);
  }

  setDisplayMode(mode: DisplayMode): void {
    this.#displayMode = mode;
    this.refresh();
  }

  setShift(down: boolean): void {
    if (down === this.#shift) return;
    this.#shift = down;
    if (this.#term) this.#paintOia(this.#term.oia.state);
  }

  focus(): void {
    this.element.focus();
  }

  dispose(): void {
    this.detach();
    for (const l of this.#listeners.splice(0)) l();
    this.element.remove();
  }

  /** The selected text, rows separated by newlines (non-display fields blank). */
  get selectionText(): string {
    const sel = this.#selection;
    const term = this.#term;
    if (!sel || !term) return '';
    const lines = term.text.slice(sel.a.row, sel.b.row + 1);
    return lines
      .map((line, i) => {
        const r = sel.a.row + i;
        const from = r === sel.a.row ? sel.a.col : 0;
        const to = r === sel.b.row ? sel.b.col + 1 : line.length;
        return line.slice(from, to).trimEnd();
      })
      .join('\n');
  }

  clearSelection(): void {
    if (!this.#selection) return;
    const { a, b } = this.#selection;
    this.#selection = undefined;
    for (let r = a.row; r <= b.row; r++) this.#paintRow(r);
    this.#paintCursor();
  }

  get #mode(): DisplayMode {
    return this.#displayMode ?? (this.#term?.color ? 'color' : 'monochrome');
  }

  /** Size the canvas for the current screen geometry and font. */
  #layout(): void {
    const screen = this.#term!.screen;
    const size = this.#options.fontSize ?? 16;
    const ctx = this.#ctx;
    ctx.font = `${size}px ${this.#theme.fontFamily}`;
    this.#cw = Math.ceil(ctx.measureText('M').width) || Math.round(size * 0.6);
    this.#ch = Math.round(size * (this.#options.lineHeight ?? 1.25));
    this.#rows = screen.rows;
    this.#cols = screen.cols;
    const view = this.#doc.defaultView;
    this.#dpr = this.#options.pixelRatio ?? view?.devicePixelRatio ?? 1;
    // Screen rows, a gap, the rule, then the status line.
    const width = this.#cols * this.#cw;
    const height = (this.#rows + 1) * this.#ch + this.#oiaGap;
    this.canvas.width = Math.round(width * this.#dpr);
    this.canvas.height = Math.round(height * this.#dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    ctx.font = `${size}px ${this.#theme.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.#theme.colors.background;
    ctx.fillRect(0, 0, width, height);
  }

  get #oiaGap(): number {
    return Math.round(this.#ch / 4);
  }

  #paintDirty(): void {
    const screen = this.#term!.screen;
    if (screen.rows !== this.#rows || screen.cols !== this.#cols) {
      this.refresh();
      return;
    }
    const dirty = new Set(screen.takeDirtyRows());
    // The cursor's old row must lose its cursor even if the screen didn't mark it.
    if (this.#cursorRow >= 0) dirty.add(this.#cursorRow);
    for (const r of dirty) this.#paintRow(r);
    this.#paintCursor();
  }

  #paintRow(r: number): void {
    const term = this.#term!;
    const ctx = this.#ctx;
    const { colors } = this.#theme;
    const y = r * this.#ch;
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, y, this.#cols * this.#cw, this.#ch);

    let blinks = false;
    for (const run of rowRuns(term.screen, r, {
      codePage: term.codePage,
      displayMode: this.#mode,
    })) {
      const s = run.style;
      const fg = colors[s.fg];
      const bg = s.bg === 'background' ? undefined : colors[s.bg];
      const x = run.start * this.#cw;
      const w = run.length * this.#cw;
      const [text, back] = s.reverse ? [bg ?? colors.background, fg] : [fg, bg];
      if (back) {
        ctx.fillStyle = back;
        ctx.fillRect(x, y, w, this.#ch);
      }
      if (s.blink) blinks = true;
      if (s.blink && !this.#blinkOn) continue;
      ctx.fillStyle = text;
      // One cell per character; combining overlines stay with their base.
      const cells = splitCells(run.text);
      for (let i = 0; i < cells.length; i++) {
        if (cells[i] !== ' ') ctx.fillText(cells[i]!, x + i * this.#cw, y + this.#ch / 2);
      }
      if (s.underscore) ctx.fillRect(x, y + this.#ch - 2, w, 1);
      if (s.outline) {
        // Field outlining, in the text colour, on the cell edges.
        ctx.fillStyle = fg;
        if (s.outline & OUTLINE.TOP) ctx.fillRect(x, y, w, 1);
        if (s.outline & OUTLINE.BOTTOM) ctx.fillRect(x, y + this.#ch - 1, w, 1);
        if (s.outline & OUTLINE.LEFT) ctx.fillRect(x, y, 1, this.#ch);
        if (s.outline & OUTLINE.RIGHT) ctx.fillRect(x + w - 1, y, 1, this.#ch);
      }
    }
    if (blinks) this.#blinkRows.add(r);
    else this.#blinkRows.delete(r);
    this.#paintSelection(r);
    this.#updateBlinkTimer();
  }

  #paintSelection(r: number): void {
    const sel = this.#selection;
    if (!sel || r < sel.a.row || r > sel.b.row) return;
    const from = r === sel.a.row ? sel.a.col : 0;
    const to = r === sel.b.row ? sel.b.col + 1 : this.#cols;
    this.#ctx.fillStyle = 'rgba(95, 135, 255, 0.35)';
    this.#ctx.fillRect(from * this.#cw, r * this.#ch, (to - from) * this.#cw, this.#ch);
  }

  #paintCursor(): void {
    const screen = this.#term!.screen;
    const row = Math.floor(screen.cursor / screen.cols);
    const col = screen.cursor % screen.cols;
    this.#cursorRow = row;
    if (this.#options.cursorBlink && !this.#blinkOn) return;
    const ctx = this.#ctx;
    ctx.fillStyle = this.#theme.cursor;
    const x = col * this.#cw;
    const y = row * this.#ch;
    if (this.#options.cursorStyle === 'underline') {
      ctx.fillRect(x, y + this.#ch - 3, this.#cw, 3);
    } else {
      ctx.globalAlpha = 0.6;
      ctx.fillRect(x, y, this.#cw, this.#ch);
      ctx.globalAlpha = 1;
    }
  }

  #paintOia(state: OiaState): void {
    if (!this.#term) return;
    this.#oiaTextEl.textContent = oiaDescription(state);
    const ctx = this.#ctx;
    const ruleY = this.#rows * this.#ch + Math.floor(this.#oiaGap / 2);
    const y = this.#rows * this.#ch + this.#oiaGap;
    const width = this.#cols * this.#cw;
    ctx.fillStyle = this.#theme.colors.background;
    ctx.fillRect(0, this.#rows * this.#ch, width, this.#oiaGap + this.#ch);
    ctx.fillStyle = this.#theme.oiaRule;
    ctx.fillRect(0, ruleY, width, 1);
    ctx.fillStyle = this.#theme.oia;
    const cells = oiaCells(state, { cols: this.#cols, shift: this.#shift });
    cells.forEach((cell, col) => {
      if (!cell) return;
      const x = col * this.#cw;
      if ('glyph' in cell) this.#drawGlyph(cell.glyph, x, y);
      else ctx.fillText(cell.char, x, y + this.#ch / 2);
    });
  }

  #drawGlyph(glyph: OiaGlyph, x: number, y: number): void {
    const ctx = this.#ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(this.#cw / OIA_GLYPH_SIZE.width, this.#ch / OIA_GLYPH_SIZE.height);
    ctx.fill(new Path2D(OIA_GLYPHS[glyph]));
    ctx.restore();
  }

  #announce(): void {
    this.#liveEl.textContent = this.#term!.text.map((l) => l.trimEnd())
      .join('\n')
      .trim();
  }

  #updateBlinkTimer(): void {
    const needed = this.#blinkRows.size > 0 || this.#options.cursorBlink === true;
    if (needed && !this.#blinkTimer && this.#term) {
      this.#blinkTimer = setInterval(() => this.#blink(), BLINK_MS);
    } else if (!needed) {
      this.#stopBlink();
    }
  }

  #stopBlink(): void {
    if (this.#blinkTimer) clearInterval(this.#blinkTimer);
    this.#blinkTimer = undefined;
    this.#blinkOn = true;
  }

  #blink(): void {
    if (!this.#term) return;
    this.#blinkOn = !this.#blinkOn;
    for (const r of [...this.#blinkRows]) this.#paintRow(r);
    if (this.#cursorRow >= 0 && !this.#blinkRows.has(this.#cursorRow))
      this.#paintRow(this.#cursorRow);
    this.#paintCursor();
  }

  cellAt(clientX: number, clientY: number): { row: number; col: number } | undefined {
    if (!this.#cw) return undefined;
    const rect = this.canvas.getBoundingClientRect();
    const col = Math.floor((clientX - rect.left) / this.#cw);
    const row = Math.floor((clientY - rect.top) / this.#ch);
    if (row < 0 || row >= this.#rows || col < 0 || col >= this.#cols) return undefined;
    return { row, col };
  }

  #cellAt(e: MouseEvent): { row: number; col: number } | undefined {
    return this.cellAt(e.clientX, e.clientY);
  }

  #listen(): void {
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      el.addEventListener(type, fn);
      this.#listeners.push(() => el.removeEventListener(type, fn));
    };
    on(this.canvas, 'mousedown', (e) => {
      if (e.button !== 0) return;
      this.clearSelection();
      this.#dragFrom = this.#cellAt(e);
    });
    on(this.canvas, 'mousemove', (e) => {
      if (!this.#dragFrom || (e.buttons & 1) === 0) return;
      const to = this.#cellAt(e);
      if (!to) return;
      const old = this.#selection;
      const [a, b] =
        to.row < this.#dragFrom.row ||
        (to.row === this.#dragFrom.row && to.col < this.#dragFrom.col)
          ? [to, this.#dragFrom]
          : [this.#dragFrom, to];
      this.#selection = { a, b };
      const rows = new Set<number>();
      for (const s of [old, this.#selection]) {
        if (s) for (let r = s.a.row; r <= s.b.row; r++) rows.add(r);
      }
      for (const r of rows) this.#paintRow(r);
      this.#paintCursor();
    });
    on(this.canvas, 'mouseup', () => (this.#dragFrom = undefined));
    // Cmd/Ctrl+C in the focused input element bubbles a copy event to us.
    on(this.element, 'copy', (e) => {
      const text = this.selectionText;
      if (!text) return;
      e.clipboardData?.setData('text/plain', text);
      e.preventDefault();
    });
  }
}

/** Split text into display cells: a base character plus any combining marks. */
function splitCells(text: string): string[] {
  return text.match(/\P{M}\p{M}*/gu) ?? [];
}

function injectStyles(doc: Document): void {
  if (doc.querySelector('style[data-3270js]')) return;
  const style = doc.createElement('style');
  style.setAttribute('data-3270js', '');
  style.textContent = DOM_CSS;
  doc.head.append(style);
}
