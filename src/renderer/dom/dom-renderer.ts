/**
 * DomRenderer: draws a Terminal with ordinary DOM elements. Each row is a
 * block element of styled spans, so text selection and copy work natively and
 * the screen is readable by assistive technology. Only changed rows are
 * repainted.
 */
import type { OiaLockSymbol, OiaState } from '../../core/oia/index.js';
import type { Terminal } from '../../core/terminal.js';
import { type DisplayMode, type Run, rowRuns } from '../cell-style.js';
import type { CellMetrics, Renderer, RendererOptions } from '../renderer.js';
import { OIA_GLYPHS, OIA_GLYPH_SIZE } from '../oia-glyphs.js';
import { type OiaCell, oiaCells, oiaDescription } from '../oia-layout.js';
import { DEFAULT_THEME, type Theme } from '../theme.js';
import { DOM_CSS } from './styles.js';

/** Status-line wording for each lock symbol when glyphs are off (as c3270 shows them). */
const LOCK_TEXT: Record<OiaLockSymbol, string> = {
  system: 'X SYSTEM',
  clock: 'X Wait',
  notConnected: 'X Not Connected',
  doNotEnter: 'X Protected',
  numeric: 'X Numeric',
  tooMuch: 'X Overflow',
};

export class DomRenderer implements Renderer {
  readonly element: HTMLElement;
  readonly #doc: Document;
  readonly #screenEl: HTMLElement;
  readonly #cursorEl: HTMLElement;
  readonly #oiaEl: HTMLElement;
  readonly #liveEl: HTMLElement;
  readonly #oiaTextEl: HTMLElement;
  readonly #theme: Theme;
  readonly #oiaGlyphs: boolean;
  #shift = false;
  #rows: HTMLElement[] = [];
  #cols = 0;
  #displayMode: DisplayMode | undefined;
  #term: Terminal | undefined;
  #unsubscribe: (() => void)[] = [];

  constructor(container: HTMLElement, options: RendererOptions = {}) {
    this.#doc = container.ownerDocument;
    this.#theme = options.theme ?? DEFAULT_THEME;
    this.#displayMode = options.displayMode;
    this.#oiaGlyphs = options.oiaGlyphs ?? true;
    injectStyles(this.#doc);

    const el = (cls: string) => {
      const e = this.#doc.createElement('div');
      e.className = cls;
      return e;
    };
    this.element = el('t3270');
    this.element.tabIndex = 0;
    this.element.setAttribute('role', 'application');
    this.element.setAttribute('aria-label', 'IBM 3270 terminal');
    this.element.setAttribute('aria-roledescription', 'terminal');
    const t = this.#theme;
    Object.assign(this.element.style, {
      backgroundColor: t.colors.background,
      color: t.colors.default,
      fontFamily: t.fontFamily,
    });
    this.element.style.setProperty('--t3270-cursor', t.cursor);
    this.element.style.setProperty('--t3270-oia', t.oia);
    this.element.style.setProperty('--t3270-oia-rule', t.oiaRule);

    this.#screenEl = el('t3270-screen');
    this.#cursorEl = el(
      `t3270-cursor t3270-cursor-${options.cursorStyle ?? 'block'}${options.cursorBlink ? ' t3270-blink' : ''}`,
    );
    this.#oiaEl = el('t3270-oia');
    this.#oiaEl.setAttribute('aria-hidden', 'true');
    this.#oiaTextEl = el('t3270-sr-only');
    this.#liveEl = el('t3270-sr-only');
    this.#liveEl.setAttribute('aria-live', 'polite');
    this.#liveEl.setAttribute('aria-atomic', 'true');

    this.#screenEl.append(this.#cursorEl);
    this.element.append(this.#screenEl, this.#oiaEl, this.#oiaTextEl, this.#liveEl);
    container.append(this.element);
  }

  get cellMetrics(): CellMetrics | undefined {
    const probe = this.#doc.createElement('span');
    probe.textContent = 'M'.repeat(10);
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    this.#screenEl.append(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    const row = this.#rows[0]?.getBoundingClientRect();
    if (!rect.width || !row?.height) return undefined;
    return { width: rect.width / 10, height: row.height };
  }

  cellAt(clientX: number, clientY: number): { row: number; col: number } | undefined {
    const m = this.cellMetrics;
    if (!m) return undefined;
    const rect = this.#screenEl.getBoundingClientRect();
    const col = Math.floor((clientX - rect.left) / m.width);
    const row = Math.floor((clientY - rect.top) / m.height);
    if (row < 0 || row >= this.#rows.length || col < 0 || col >= this.#cols) return undefined;
    return { row, col };
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
  }

  refresh(): void {
    const term = this.#term;
    if (!term) return;
    this.#rebuildRows();
    term.screen.takeDirtyRows();
    for (let r = 0; r < term.screen.rows; r++) this.#paintRow(r);
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
    this.element.remove();
  }

  get #mode(): DisplayMode {
    return this.#displayMode ?? (this.#term?.color ? 'color' : 'monochrome');
  }

  #rebuildRows(): void {
    const screen = this.#term!.screen;
    for (const r of this.#rows) r.remove();
    this.#rows = [];
    for (let r = 0; r < screen.rows; r++) {
      const row = this.#doc.createElement('div');
      row.className = 't3270-row';
      this.#rows.push(row);
      this.#screenEl.insertBefore(row, this.#cursorEl);
    }
    this.#cols = screen.cols;
  }

  #paintDirty(): void {
    const screen = this.#term!.screen;
    if (screen.rows !== this.#rows.length || screen.cols !== this.#cols) {
      this.refresh(); // the host switched screen size (EWA)
      return;
    }
    for (const r of screen.takeDirtyRows()) this.#paintRow(r);
    this.#paintCursor();
  }

  #paintRow(r: number): void {
    const term = this.#term!;
    const runs = rowRuns(term.screen, r, { codePage: term.codePage, displayMode: this.#mode });
    this.#rows[r]!.replaceChildren(...runs.map((run) => this.#span(run)));
  }

  #span(run: Run): HTMLElement {
    const { colors } = this.#theme;
    const s = run.style;
    const span = this.#doc.createElement('span');
    span.textContent = run.text;
    const fg = colors[s.fg];
    const bg = s.bg === 'background' ? undefined : colors[s.bg];
    if (s.reverse) {
      span.style.color = bg ?? colors.background;
      span.style.backgroundColor = fg;
    } else {
      span.style.color = fg;
      if (bg) span.style.backgroundColor = bg;
    }
    if (s.underscore) span.style.textDecoration = 'underline';
    if (s.blink) span.classList.add('t3270-blink');
    return span;
  }

  #paintCursor(): void {
    const screen = this.#term!.screen;
    const row = Math.floor(screen.cursor / screen.cols);
    const col = screen.cursor % screen.cols;
    this.#cursorEl.style.left = `${col}ch`;
    this.#cursorEl.style.top = `calc(${row} * var(--t3270-line))`;
  }

  #paintOia(state: OiaState): void {
    const cols = this.#cols || 80;
    this.#oiaTextEl.textContent = oiaDescription(state);
    if (!this.#oiaGlyphs) {
      this.#oiaEl.textContent = wordsOia(state, cols);
      return;
    }
    const cells = oiaCells(state, { cols, shift: this.#shift });
    const nodes: Node[] = [];
    let run = '';
    const flush = () => {
      if (run) nodes.push(this.#doc.createTextNode(run));
      run = '';
    };
    for (const cell of cells) {
      if (cell && 'glyph' in cell) {
        flush();
        nodes.push(this.#glyph(cell));
      } else {
        run += cell ? cell.char : ' ';
      }
    }
    flush();
    this.#oiaEl.replaceChildren(...nodes);
  }

  #glyph(cell: Extract<OiaCell, { glyph: string }>): Element {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = this.#doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${OIA_GLYPH_SIZE.width} ${OIA_GLYPH_SIZE.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 't3270-glyph');
    svg.setAttribute('data-glyph', cell.glyph);
    const path = this.#doc.createElementNS(NS, 'path');
    path.setAttribute('d', OIA_GLYPHS[cell.glyph]);
    svg.append(path);
    return svg;
  }

  #announce(): void {
    const text = this.#term!.text.map((l) => l.trimEnd())
      .join('\n')
      .trim();
    this.#liveEl.textContent = text;
  }
}

function wordsOia(state: OiaState, cols: number): string {
  const line = Array.from({ length: cols }, () => ' ');
  const put = (at: number, text: string) => {
    for (let i = 0; i < text.length && at + i < cols; i++) line[at + i] = text[i]!;
  };
  if (state.connection === 'connected') put(0, '4A');
  else if (state.connection === 'connecting') put(0, '4?');
  if (state.lock) put(8, LOCK_TEXT[state.lock.symbol]);
  if (state.insert) put(cols - 29, '^');
  const pos = (n: number) => String(n + 1).padStart(3, '0');
  put(cols - 7, `${pos(state.cursor.row)}/${pos(state.cursor.col)}`);
  return line.join('');
}

function injectStyles(doc: Document): void {
  if (doc.querySelector('style[data-3270js]')) return;
  const style = doc.createElement('style');
  style.setAttribute('data-3270js', '');
  style.textContent = DOM_CSS;
  doc.head.append(style);
}
