import { describe, expect, it } from 'vitest';
import { OiaModel, computeOia, type OiaInputs } from '../../../../src/core/oia/index.js';

const base: OiaInputs = {
  connection: 'connected',
  inhibit: undefined,
  operatorError: undefined,
  insertMode: false,
  cursor: 0,
  cols: 80,
  model: '3279-2-E',
};

describe('computeOia', () => {
  it('describes a ready keyboard', () => {
    expect(computeOia({ ...base, cursor: 1771 })).toEqual({
      connection: 'connected',
      lock: undefined,
      insert: false,
      cursor: { row: 22, col: 11 },
      model: '3279-2-E',
    });
  });

  it('maps each inhibit reason to its OIA symbol', () => {
    expect(computeOia({ ...base, inhibit: 'wait' }).lock).toEqual({
      symbol: 'clock',
      reason: 'wait',
    });
    expect(computeOia({ ...base, inhibit: 'system' }).lock).toEqual({
      symbol: 'system',
      reason: 'system',
    });
    expect(computeOia({ ...base, inhibit: 'awaitingFirst' }).lock).toEqual({
      symbol: 'system',
      reason: 'awaitingFirst',
    });
    expect(
      computeOia({ ...base, connection: 'disconnected', inhibit: 'notConnected' }).lock,
    ).toEqual({ symbol: 'notConnected', reason: 'notConnected' });
  });

  it('maps operator errors to their OIA symbols', () => {
    expect(computeOia({ ...base, operatorError: 'protected' }).lock).toEqual({
      symbol: 'doNotEnter',
      reason: 'protected',
    });
    expect(computeOia({ ...base, operatorError: 'numeric' }).lock).toEqual({
      symbol: 'numeric',
      reason: 'numeric',
    });
    expect(computeOia({ ...base, operatorError: 'overflow' }).lock).toEqual({
      symbol: 'tooMuch',
      reason: 'overflow',
    });
  });

  it('shows the system inhibit in preference to an operator error', () => {
    expect(computeOia({ ...base, inhibit: 'wait', operatorError: 'protected' }).lock?.symbol).toBe(
      'clock',
    );
  });

  it('includes the LU name when known', () => {
    expect(computeOia({ ...base, luName: 'CUU0C0' }).luName).toBe('CUU0C0');
  });
});

describe('OiaModel', () => {
  it('notifies only when the status line actually changes', () => {
    const m = new OiaModel();
    const seen: unknown[] = [];
    m.onChange((s) => seen.push(s.cursor));
    m.update({ ...base, cursor: 5 });
    m.update({ ...base, cursor: 5 });
    m.update({ ...base, cursor: 6 });
    expect(seen).toEqual([
      { row: 0, col: 5 },
      { row: 0, col: 6 },
    ]);
    expect(m.state.cursor).toEqual({ row: 0, col: 6 });
  });

  it('can unsubscribe', () => {
    const m = new OiaModel();
    let n = 0;
    const off = m.onChange(() => n++);
    off();
    m.update({ ...base, insertMode: true });
    expect(n).toBe(0);
  });

  it('starts disconnected', () => {
    expect(new OiaModel().state).toMatchObject({
      connection: 'disconnected',
      lock: { symbol: 'notConnected' },
    });
  });
});
