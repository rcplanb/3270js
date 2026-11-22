// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  BlockSelector,
  blockRect,
  blockText,
  type BlockRect,
} from '../../../src/renderer/selection.js';

describe('block selection', () => {
  it('spans the rectangle between two corners, in either order', () => {
    expect(blockRect({ row: 3, col: 9 }, { row: 1, col: 2 })).toEqual({
      top: 1,
      left: 2,
      bottom: 3,
      right: 9,
    });
  });

  it('copies one line per row of the block, trailing blanks trimmed', () => {
    const lines = ['  NAME     SIZE', '  ABC.DEF    12', '  X.Y        3 '];
    expect(blockText(lines, { top: 0, left: 2, bottom: 2, right: 8 })).toBe('NAME\nABC.DEF\nX.Y');
    expect(blockText(lines, { top: 1, left: 11, bottom: 2, right: 14 })).toBe('  12\n  3');
  });

  function setup() {
    const target = document.createElement('div');
    document.body.append(target);
    const changes: (BlockRect | undefined)[] = [];
    const sel = new BlockSelector({
      target,
      copyTarget: target,
      // 10×20-pixel cells
      cellAt: (x, y) => ({ row: Math.floor(y / 20), col: Math.floor(x / 10) }),
      lines: () => ['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ0123'],
      changed: (next) => changes.push(next),
    });
    const mouse = (type: string, x: number, y: number, extra: MouseEventInit = {}) =>
      target.dispatchEvent(
        new MouseEvent(type, {
          clientX: x,
          clientY: y,
          button: 0,
          buttons: 1,
          bubbles: true,
          ...extra,
        }),
      );
    return { sel, mouse, changes, target };
  }

  it('selects by dragging, and a click alone selects nothing', () => {
    const { sel, mouse } = setup();
    mouse('mousedown', 15, 5); // row 0, col 1
    mouse('mousemove', 18, 8); // same cell
    mouse('mouseup', 18, 8);
    expect(sel.text).toBe('');
    mouse('mousedown', 15, 5);
    mouse('mousemove', 35, 45); // row 2, col 3
    mouse('mouseup', 35, 45);
    expect(sel.text).toBe('BCD\nLMN\nVWX');
  });

  it('extends from the anchor with Shift', () => {
    const { sel, mouse } = setup();
    mouse('mousedown', 15, 5);
    mouse('mousemove', 25, 25);
    mouse('mouseup', 25, 25);
    expect(sel.text).toBe('BC\nLM');
    mouse('mousedown', 55, 45, { shiftKey: true }); // row 2, col 5
    mouse('mouseup', 55, 45);
    expect(sel.text).toBe('BCDEF\nLMNOP\nVWXYZ');
  });

  it('clears on a new click and on clear()', () => {
    const { sel, mouse, changes } = setup();
    sel.select({ row: 0, col: 0 }, { row: 1, col: 1 });
    expect(sel.text).toBe('AB\nKL');
    mouse('mousedown', 95, 45);
    expect(sel.text).toBe('');
    expect(changes.at(-1)).toBeUndefined();
    sel.select({ row: 0, col: 0 }, { row: 0, col: 0 });
    sel.clear();
    expect(sel.rect).toBeUndefined();
    sel.dispose();
  });
});
