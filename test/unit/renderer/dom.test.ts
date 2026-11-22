// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '../../../src/core/terminal.js';
import { DomRenderer } from '../../../src/renderer/dom/dom-renderer.js';
import { DEFAULT_THEME } from '../../../src/renderer/theme.js';
import { FakeHost, HERCULES_NEGOTIATION, frame } from '../../helpers/fake-host.js';
import { cp037 } from '../../../src/core/codepage/index.js';

const ebc = (s: string) => Buffer.from(cp037.encode(s)).toString('hex');

async function setup(options: ConstructorParameters<typeof DomRenderer>[1] = {}, termOptions = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const term = new Terminal(termOptions);
  const host = new FakeHost();
  const renderer = new DomRenderer(container, options);
  renderer.attach(term);
  const ready = term.connect(host);
  for (const c of HERCULES_NEGOTIATION) host.write(c);
  await ready;
  return { container, term, host, renderer };
}

const rows = (r: DomRenderer) => [...r.element.querySelectorAll<HTMLElement>('.t3270-row')];
const rowText = (r: DomRenderer, i: number) => rows(r)[i]!.textContent;

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('DomRenderer', () => {
  it('renders one row element per screen row, plus the status line', async () => {
    const { renderer, host } = await setup();
    host.write(frame('f5c3' + ebc('HELLO')));
    expect(rows(renderer)).toHaveLength(24);
    expect(rowText(renderer, 0)).toBe('HELLO' + ' '.repeat(75));
    expect(renderer.element.querySelector('.t3270-oia')).not.toBeNull();
  });

  it('is focusable and labelled', async () => {
    const { renderer } = await setup();
    expect(renderer.element.tabIndex).toBe(0);
    expect(renderer.element.getAttribute('aria-label')).toMatch(/3270/);
    renderer.focus();
    expect(document.activeElement).toBe(renderer.element);
  });

  it('draws runs as spans with theme colours, monochrome by default for a 3278', async () => {
    const { renderer, host } = await setup();
    host.write(frame('f5c3' + '1d60' + ebc('PROT') + '1d48' + ebc('BRIGHT')));
    const spans = [...rows(renderer)[0]!.querySelectorAll('span')];
    expect(spans[0]!.textContent).toBe(' PROT');
    expect(spans[0]!.style.color).toBe(DEFAULT_THEME.colors.default);
    expect(spans[1]!.textContent.startsWith(' BRIGHT')).toBe(true);
    expect(spans[1]!.style.color).toBe(DEFAULT_THEME.colors.intensified);
  });

  it('switches to 3279 colours live', async () => {
    const { renderer, host } = await setup();
    host.write(frame('f5c3' + '1d60' + ebc('PROT')));
    renderer.setDisplayMode('color');
    const span = rows(renderer)[0]!.querySelector('span')!;
    expect(span.style.color).toBe(DEFAULT_THEME.colors.blue);
  });

  it('defaults to colour for a 3279 terminal', async () => {
    const { renderer, host } = await setup({}, { color: true });
    host.write(frame('f5c3' + '1d60' + ebc('PROT')));
    expect(rows(renderer)[0]!.querySelector('span')!.style.color).toBe(DEFAULT_THEME.colors.blue);
  });

  it('applies reverse video, underscore and blink', async () => {
    const { renderer, host } = await setup();
    host.write(frame('f5c3' + '2841f2' + ebc('R') + '2841f4' + ebc('U') + '2841f1' + ebc('B')));
    const [r, u, b] = [...rows(renderer)[0]!.querySelectorAll('span')];
    expect(r!.style.color).toBe(DEFAULT_THEME.colors.background);
    expect(r!.style.backgroundColor).toBe(DEFAULT_THEME.colors.default);
    expect(u!.style.textDecoration).toBe('underline');
    expect(b!.classList.contains('t3270-blink')).toBe(true);
  });

  it('never shows non-display fields', async () => {
    const { renderer, host } = await setup();
    host.write(frame('f5c3' + '1d4c' + ebc('SECRET')));
    expect(renderer.element.textContent).not.toContain('SECRET');
  });

  it('repaints only the rows that changed', async () => {
    const { renderer, host } = await setup();
    host.write(frame('f5c3' + ebc('ROW0') + '11c150' + ebc('ROW1')));
    const before = rows(renderer).map((r) => r.firstChild);
    host.write(frame('f1c2' + '11c150' + ebc('NEW1')));
    const after = rows(renderer).map((r) => r.firstChild);
    expect(after[0]).toBe(before[0]); // untouched
    expect(after[1]).not.toBe(before[1]); // repainted
    expect(rowText(renderer, 1).startsWith('NEW1')).toBe(true);
  });

  it('places the cursor with CSS cell units, and moves it', async () => {
    const { renderer, host, term } = await setup();
    host.write(frame('f5c2' + '11c150' + '13')); // IC at row 1, col 0
    const cursor = renderer.element.querySelector<HTMLElement>('.t3270-cursor')!;
    expect(cursor.style.left).toBe('0ch');
    expect(cursor.style.top).toBe('calc(1 * var(--t3270-line))');
    term.press({ type: 'right' });
    expect(cursor.style.left).toBe('1ch');
  });

  it('supports block and underline cursors', async () => {
    const { renderer } = await setup({ cursorStyle: 'underline', cursorBlink: true });
    const cursor = renderer.element.querySelector('.t3270-cursor')!;
    expect(cursor.classList.contains('t3270-cursor-underline')).toBe(true);
    expect(cursor.classList.contains('t3270-blink')).toBe(true);
  });

  it('draws the status line with x3270 glyphs: boxes, X, clock, insert, cursor', async () => {
    const { renderer, host, term } = await setup();
    const glyphs = () =>
      [...renderer.element.querySelectorAll('.t3270-oia [data-glyph]')].map((e) =>
        e.getAttribute('data-glyph'),
      );
    const oia = () => renderer.element.querySelector('.t3270-oia')!.textContent;
    expect(glyphs()).toEqual(['box4', 'underA', 'boxSolid', 'lock']); // awaiting the first write
    expect(oia()).toContain('[Field]');
    host.write(frame('f5c2' + '11c150' + '13'));
    expect(glyphs()).toEqual(['box4', 'underA', 'boxSolid']);
    expect(oia()).toContain('002/001');
    term.press({ type: 'insert' });
    expect(glyphs()).toContain('insert');
    term.screen.cursor = 0;
    term.type('A');
    term.aid('ENTER');
    expect(glyphs()).toEqual(['box4', 'underA', 'boxSolid', 'lock', 'clockLeft', 'clockRight']);
  });

  it('shows the shift indicator on request', async () => {
    const { renderer } = await setup();
    renderer.setShift(true);
    expect(renderer.element.querySelector('[data-glyph="upShift"]')).not.toBeNull();
    renderer.setShift(true);
    renderer.setShift(false);
    expect(renderer.element.querySelector('[data-glyph="upShift"]')).toBeNull();
  });

  it('describes the status line in words for assistive technology', async () => {
    const { renderer } = await setup();
    expect(renderer.element.querySelector('.t3270-oia')!.getAttribute('aria-hidden')).toBe('true');
    expect(renderer.element.textContent).toContain(
      'Connected; input inhibited, waiting for the host',
    );
  });

  it('can show the status line in words instead of glyphs', async () => {
    const { renderer, host, term } = await setup({ oiaGlyphs: false });
    const oia = () => renderer.element.querySelector('.t3270-oia')!.textContent;
    expect(oia()).toContain('X SYSTEM');
    host.write(frame('f5c2' + '11c150' + '13'));
    expect(oia()).not.toContain('X ');
    expect(oia()).toContain('002/001');
    term.press({ type: 'insert' });
    expect(oia()).toContain('^');
    term.screen.cursor = 0;
    term.type('A');
    term.aid('ENTER');
    expect(oia()).toContain('X Wait');
  });

  it('rebuilds rows when the host switches to the alternate size', async () => {
    const { renderer, host } = await setup({}, { model: 5 });
    host.write(frame('7ec3'));
    expect(rows(renderer)).toHaveLength(27);
    expect(rowText(renderer, 0)).toHaveLength(132);
  });

  it('announces the screen to assistive technology when the host finishes', async () => {
    const { renderer, host } = await setup();
    host.write(frame('f5c2' + ebc('READY')));
    const live = renderer.element.querySelector('[aria-live]')!;
    expect(live.textContent).toContain('READY');
  });

  it('injects its stylesheet once per document', async () => {
    await setup();
    await setup();
    expect(document.querySelectorAll('style[data-3270js]')).toHaveLength(1);
  });

  it('stops following the terminal when detached, and cleans up on dispose', async () => {
    const { renderer, host, container } = await setup();
    host.write(frame('f5c3' + ebc('ONE')));
    renderer.detach();
    host.write(frame('f5c3' + ebc('TWO')));
    expect(rowText(renderer, 0).startsWith('ONE')).toBe(true);
    renderer.dispose();
    expect(container.children).toHaveLength(0);
  });

  it('refresh() repaints everything', async () => {
    const { renderer, host } = await setup();
    host.write(frame('f5c3' + ebc('X')));
    const before = rows(renderer)[5]!.firstChild;
    renderer.refresh();
    expect(rows(renderer)[5]!.firstChild).not.toBe(before);
  });

  it('reports cell metrics once laid out (none in a layout-less DOM)', async () => {
    const { renderer } = await setup();
    expect(renderer.cellMetrics).toBeUndefined();
  });
});
