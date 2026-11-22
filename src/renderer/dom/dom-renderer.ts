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
import { DEFAULT_THEME, type Theme } from '../theme.js';
import { DOM_CSS } from './styles.js';

/**
 * Status-line wording for each lock symbol, as c3270 shows them in a text
 * terminal. The glyph-based OIA comes with the font decision (task 17).
 */
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
  readonly #theme: Theme;
  #rows: HTMLElement[] = [];
  #cols = 0;
  #displayMode: DisplayMode | undefined;
  #term: Terminal | undefined;
  #unsubscribe: (() => void)[] = [];

  constructor(container: HTMLElement, options: RendererOptions = {}) {
    this.#doc = container.ownerDocument;
    this.#theme = options.theme ?? DEFAULT_THEME;
    this.#displayMode = options.displayMode;
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
    this.#liveEl = el('t3270-sr-only');
    this.#liveEl.setAttribute('aria-live', 'polite');
    this.#liveEl.setAttribute('aria-atomic', 'true');

    this.#screenEl.append(this.#cursorEl);
    this.element.append(this.#screenEl, this.#oiaEl, this.#liveEl);
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
    const line = Array.from({ length: cols }, () => ' ');
    const put = (at: number, text: string) => {
      for (let i = 0; i < text.length && at + i < cols; i++) line[at + i] = text[i]!;
    };
    if (state.connection === 'connected') put(0, '4A');
    else if (state.connection === 'connecting') put(0, '4?');
    if (state.lock) put(8, LOCK_TEXT[state.lock.symbol]);
    if (state.insert) put(51, '^');
    const pos = (n: number) => String(n + 1).padStart(3, '0');
    put(cols - 7, `${pos(state.cursor.row)}/${pos(state.cursor.col)}`);
    this.#oiaEl.textContent = line.join('');
  }

  #announce(): void {
    const text = this.#term!.text.map((l) => l.trimEnd())
      .join('\n')
      .trim();
    this.#liveEl.textContent = text;
  }
}

function injectStyles(doc: Document): void {
  if (doc.querySelector('style[data-3270js]')) return;
  const style = doc.createElement('style');
  style.setAttribute('data-3270js', '');
  style.textContent = DOM_CSS;
  doc.head.append(style);
}
