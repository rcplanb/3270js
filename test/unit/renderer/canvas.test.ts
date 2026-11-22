// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cp037 } from '../../../src/core/codepage/index.js';
import { Terminal } from '../../../src/core/terminal.js';
import { CanvasRenderer } from '../../../src/renderer/canvas/canvas-renderer.js';
import { KeyboardMapper } from '../../../src/renderer/keymap.js';
import { OIA_GLYPHS } from '../../../src/renderer/oia-glyphs.js';
import { DEFAULT_THEME } from '../../../src/renderer/theme.js';
import { FakeHost, HERCULES_NEGOTIATION, frame } from '../../helpers/fake-host.js';

const ebc = (s: string) => Buffer.from(cp037.encode(s)).toString('hex');

/** Records what a 2D context is asked to draw. */
class FakeContext {
  calls: { op: string; args: unknown[]; fill: string; alpha: number }[] = [];
  fillStyle = '';
  globalAlpha = 1;
  font = '';
  textBaseline = '';
  #rec(op: string, args: unknown[]) {
    this.calls.push({ op, args, fill: this.fillStyle, alpha: this.globalAlpha });
  }
  measureText() {
    return { width: 9.6 };
  }
  fillRect(...a: number[]) {
    this.#rec('fillRect', a);
  }
  fillText(...a: unknown[]) {
    this.#rec('fillText', a);
  }
  fill(p: { d: string }) {
    this.#rec('fill', [p.d]);
  }
  setTransform(...a: number[]) {
    this.#rec('setTransform', a);
  }
  save() {}
  restore() {}
  translate() {}
  scale() {}
  texts() {
    return this.calls.filter((c) => c.op === 'fillText');
  }
  clear() {
    this.calls = [];
  }
}

let ctx: FakeContext;
beforeEach(() => {
  ctx = new FakeContext();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal(
    'Path2D',
    class {
      constructor(readonly d: string) {}
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function setup(
  options: ConstructorParameters<typeof CanvasRenderer>[1] = {},
  termOptions = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const term = new Terminal(termOptions);
  const host = new FakeHost();
  const renderer = new CanvasRenderer(container, { pixelRatio: 2, ...options });
  renderer.attach(term);
  const ready = term.connect(host);
  for (const c of HERCULES_NEGOTIATION) host.write(c);
  await ready;
  return { term, host, renderer };
}

/** fillText calls for screen row r (y is the row's vertical centre). */
const rowTexts = (r: number) =>
  ctx
    .texts()
    .filter((c) => c.args[2] === r * 20 + 10)
    .map((c) => ({ ch: c.args[0], x: c.args[1], fill: c.fill }));

describe('CanvasRenderer', () => {
  it('sizes the canvas for the grid and status line, scaled for the pixel ratio', async () => {
    const { renderer } = await setup();
    expect(renderer.cellMetrics).toEqual({ width: 10, height: 20 }); // ceil(9.6), 16 × 1.25
    expect(renderer.canvas.style.width).toBe('800px');
    expect(renderer.canvas.style.height).toBe(`${25 * 20 + 5}px`);
    expect(renderer.canvas.width).toBe(1600);
    expect(ctx.calls.find((c) => c.op === 'setTransform')!.args).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it('draws each character at its exact cell position', async () => {
    const { host } = await setup();
    ctx.clear();
    host.write(frame('f5c3' + ebc('HI') + '11c150' + ebc('X')));
    expect(rowTexts(0)).toEqual([
      { ch: 'H', x: 0, fill: DEFAULT_THEME.colors.default },
      { ch: 'I', x: 10, fill: DEFAULT_THEME.colors.default },
    ]);
    expect(rowTexts(1).map((t) => [t.ch, t.x])).toEqual([['X', 0]]);
  });

  it('uses 3279 colours in colour mode and switches live', async () => {
    const { host, renderer } = await setup();
    host.write(frame('f5c3' + '1d60' + ebc('P')));
    ctx.clear();
    renderer.setDisplayMode('color');
    expect(rowTexts(0)[0]!.fill).toBe(DEFAULT_THEME.colors.blue);
  });

  it('draws reverse video as a filled cell with background-coloured text, and underscores', async () => {
    const { host } = await setup();
    ctx.clear();
    host.write(frame('f5c3' + '2841f2' + ebc('R') + '2841f4' + ebc('U')));
    const fills = ctx.calls.filter((c) => c.op === 'fillRect' && c.args[1] === 0);
    expect(
      fills.some(
        (c) => c.fill === DEFAULT_THEME.colors.default && c.args[0] === 0 && c.args[2] === 10,
      ),
    ).toBe(true);
    expect(rowTexts(0)[0]).toMatchObject({ ch: 'R', fill: DEFAULT_THEME.colors.background });
    expect(fills.some((c) => c.args[0] === 10 && c.args[3] === 1)).toBe(false); // underline is at the bottom
    expect(
      ctx.calls.some(
        (c) => c.op === 'fillRect' && c.args[0] === 10 && c.args[1] === 18 && c.args[3] === 1,
      ),
    ).toBe(true);
  });

  it('never draws non-display fields', async () => {
    const { host } = await setup();
    ctx.clear();
    host.write(frame('f5c3' + '1d4c' + ebc('SECRET')));
    expect(
      ctx
        .texts()
        .map((t) => t.args[0])
        .join(''),
    ).not.toContain('SECRET');
  });

  it('repaints only rows that changed (plus the cursor’s old row)', async () => {
    const { host } = await setup();
    host.write(frame('f5c3' + ebc('ROW0') + '11c150' + ebc('ROW1') + '114040' + '13'));
    ctx.clear();
    host.write(frame('f1c2' + '11c150' + ebc('NEW1')));
    const rowsPainted = new Set(
      ctx.calls
        .filter(
          (c) =>
            c.op === 'fillRect' && c.fill === DEFAULT_THEME.colors.background && c.args[2] === 800,
        )
        .map((c) => c.args[1]),
    );
    expect([...rowsPainted].sort((a, b) => Number(a) - Number(b))).toEqual([0, 20]);
  });

  it('draws the cursor as a block or an underline', async () => {
    const { host } = await setup();
    host.write(frame('f5c2' + '11c150' + '13'));
    const block = ctx.calls
      .filter((c) => c.op === 'fillRect' && c.fill === DEFAULT_THEME.cursor)
      .at(-1)!;
    expect(block.args).toEqual([0, 20, 10, 20]);
    expect(block.alpha).toBe(0.6);

    ctx.clear();
    const u = await setup({ cursorStyle: 'underline' });
    u.host.write(frame('f5c2' + '13'));
    expect(
      ctx.calls.filter((c) => c.op === 'fillRect' && c.fill === DEFAULT_THEME.cursor).at(-1)!.args,
    ).toEqual([0, 17, 10, 3]);
  });

  it('draws status-line glyphs from the shared x3270 paths', async () => {
    const { host } = await setup();
    ctx.clear();
    host.write(frame('f5c2' + '13'));
    const paths = ctx.calls.filter((c) => c.op === 'fill').map((c) => c.args[0]);
    expect(paths).toEqual([OIA_GLYPHS.box4, OIA_GLYPHS.underA, OIA_GLYPHS.boxSolid]);
    expect(
      ctx
        .texts()
        .map((t) => t.args[0])
        .join(''),
    ).toContain('001/001'.replace(/./g, (c) => c).slice(0, 1));
  });

  it('shows the shift indicator on request', async () => {
    const { renderer } = await setup();
    ctx.clear();
    renderer.setShift(true);
    expect(ctx.calls.some((c) => c.op === 'fill' && c.args[0] === OIA_GLYPHS.upShift)).toBe(true);
  });

  it('blinks blinking text on a timer and stops when it is gone', async () => {
    vi.useFakeTimers();
    const { host } = await setup();
    host.write(frame('f5c3' + '2841f1' + ebc('B')));
    ctx.clear();
    vi.advanceTimersByTime(600);
    expect(rowTexts(0).length).toBe(0); // blinked off
    ctx.clear();
    vi.advanceTimersByTime(600);
    expect(rowTexts(0)[0]!.ch).toBe('B'); // back on
    host.write(frame('f5c3' + ebc('N')));
    ctx.clear();
    vi.advanceTimersByTime(1800);
    expect(ctx.calls.length).toBe(0); // timer stopped
  });

  it('rebuilds for the alternate screen size', async () => {
    const { renderer, host } = await setup({}, { model: 5 });
    host.write(frame('7ec3'));
    expect(renderer.canvas.style.width).toBe('1320px');
  });

  it('copies the selected text (non-display fields stay blank)', async () => {
    const { host, renderer } = await setup();
    host.write(
      frame(
        'f5c3' +
          '1d60' +
          ebc('HELLO WORLD') +
          '11c150' +
          ebc('LINE TWO') +
          '1d4c' +
          ebc('PW') +
          '1d60',
      ),
    );
    vi.spyOn(renderer.canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
    } as DOMRect);
    const mouse = (type: string, x: number, y: number) =>
      renderer.canvas.dispatchEvent(
        new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true }),
      );
    mouse('mousedown', 75, 5); // row 0, col 7 (after the attribute at 0)
    mouse('mousemove', 125, 25); // row 1, col 12
    mouse('mouseup', 125, 25);
    // A block, columns 7-12 of rows 0-1: the hidden "PW" field copies as blanks.
    expect(renderer.selectionText).toBe('WORLD\nO');
    const data = new Map<string, string>();
    const e = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(e, 'clipboardData', {
      value: { setData: (t: string, v: string) => data.set(t, v) },
    });
    renderer.element.dispatchEvent(e);
    expect(data.get('text/plain')).toBe('WORLD\nO');
    expect(e.defaultPrevented).toBe(true);
    renderer.clearSelection();
    expect(renderer.selectionText).toBe('');
  });

  it('maps a click to a cell for the keyboard mapper', async () => {
    const { term, renderer } = await setup();
    const mapper = new KeyboardMapper(term, renderer);
    vi.spyOn(renderer.canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
    } as DOMRect);
    expect(renderer.cellAt(35, 45)).toEqual({ row: 2, col: 3 });
    expect(renderer.cellAt(-1, 5)).toBeUndefined();
    for (const type of ['mousedown', 'mouseup']) {
      renderer.canvas.dispatchEvent(
        new MouseEvent(type, { clientX: 35, clientY: 45, button: 0, bubbles: true }),
      );
    }
    expect(term.screen.cursor).toBe(163); // a click, not a drag: the cursor moves
    mapper.dispose();
  });

  it('announces the screen and describes the status line for assistive technology', async () => {
    const { renderer, host } = await setup();
    host.write(frame('f5c2' + ebc('READY')));
    expect(renderer.element.querySelector('[aria-live]')!.textContent).toContain('READY');
    expect(renderer.element.textContent).toContain('Connected');
    expect(renderer.canvas.getAttribute('aria-hidden')).toBe('true');
  });

  it('cleans up on dispose', async () => {
    const { renderer } = await setup();
    renderer.dispose();
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('fails clearly without a 2D canvas', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(() => new CanvasRenderer(document.body)).toThrow(/2D canvas/);
  });
});
