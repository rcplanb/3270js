import { describe, expect, it, vi } from 'vitest';
import { Aid } from '../../../../src/core/inbound/index.js';
import { SessionObserver } from '../../../../src/core/observer/index.js';
import { frame } from '../../../helpers/fake-host.js';

/** A framed record, as bytes. */
const rec = (h: string) => Uint8Array.from(Buffer.from(frame(h), 'hex'));

const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const ascii = (t: string) => Buffer.from(t, 'latin1').toString('hex');
const ebc = (t: string) =>
  [...t]
    .map((c) => ({ ' ': '40', S: 'e2', Y: 'e8', '1': 'f1', H: 'c8', I: 'c9' })[c] ?? '00')
    .join('');

/** OS/390 2.10's TN3270E negotiation, as the observer sees both sides. */
function tn3270eObserver(options = {}) {
  const o = new SessionObserver(options);
  o.host(hex('fffd28'));
  o.terminal(hex('fffb28'));
  o.host(hex('fffa280802fff0'));
  o.host(hex(`fffa280204${ascii('IBM-3278-2-E')}01${ascii('SC0TCP01')}fff0`));
  o.terminal(hex('fffa280307000204fff0'));
  o.host(hex('fffa280304000204fff0')); // FUNCTIONS IS BIND-IMAGE RESPONSES SYSREQ
  return o;
}
const BIND = '03000000003101030391903080008487f88000028000000000185000007e000006e3c5d3d5c5e300';
/** A hidden unprotected field at 0 (cursor in it), protected field at 9. */
const PASSWORD_SCREEN = 'f5c3' + '1d4c' + '13' + '1140c9' + '1d60';

describe('SessionObserver', () => {
  it('follows TN3270E: data before BIND is ignored, then the screen is written', () => {
    const o = tn3270eObserver();
    expect(o.tn3270e).toBe(true);
    expect(o.sessionMode).toBe('unbound');
    o.host(rec('0000000000' + 'f5c3' + ebc('HI')));
    expect(o.text[0]!.trim()).toBe('');
    o.host(rec(BIND));
    o.host(rec('0000000000' + 'f5c3' + ebc('HI')));
    expect(o.text[0]!.trim()).toBe('HI');
    expect(o.sessionMode).toBe('lu-lu');
  });

  it('shows SSCP-LU text and clears on UNBIND', () => {
    const o = tn3270eObserver();
    o.host(rec('0700000000' + ebc('SYS1')));
    expect(o.sessionMode).toBe('sscp-lu');
    expect(o.text[0]!.trim()).toBe('SYS1');
    o.host(rec('040000000001'));
    expect(o.sessionMode).toBe('unbound');
    expect(o.text[0]!.trim()).toBe('');
  });

  it('reports input with hidden fields redacted, and returns redacted records', () => {
    const o = tn3270eObserver();
    const inputs: { aid: number; text: string }[] = [];
    o.on('input', (r) =>
      inputs.push({ aid: r.aid, text: Buffer.from(r.fields[0]!.data).toString('hex') }),
    );
    o.host(rec(BIND));
    o.host(rec('0000000000' + PASSWORD_SCREEN));
    expect(o.isHidden(1)).toBe(true);
    // ENTER, cursor at 5, SBA 1, "SYS1"
    const [item] = o.terminal(rec('0000000000' + '7d' + '40c5' + '1140c1' + ebc('SYS1')));
    expect(Buffer.from(item!.data).toString('hex')).toBe(
      '0000000000' + '7d40c51140c1' + '5c5c5c5c',
    );
    expect(inputs).toEqual([{ aid: Aid.ENTER, text: '5c5c5c5c' }]);
  });

  it('locks the keyboard on an AID and unlocks on a restoring write; host replies do not lock', () => {
    const o = new SessionObserver();
    expect(o.keyboardLocked).toBe(true); // until the host's first write
    o.host(rec('f5c1' + ebc('HI'))); // first write, no restore: unlocks anyway
    expect(o.keyboardLocked).toBe(false);
    o.terminal(rec('7d4040'));
    expect(o.keyboardLocked).toBe(true);
    o.host(rec('f1c1')); // write without restore: still locked (X SYSTEM)
    expect(o.keyboardLocked).toBe(true);
    o.host(rec('f1c3'));
    expect(o.keyboardLocked).toBe(false);
    o.terminal(rec('88000481ff')); // a Query Reply
    expect(o.keyboardLocked).toBe(false);
  });

  it('emits ready once the keyboard is unlocked and the host is quiet (with timers)', () => {
    vi.useFakeTimers();
    try {
      const o = new SessionObserver({ quietMs: 200, timers: { setTimeout, clearTimeout } });
      const ready = vi.fn();
      o.on('ready', ready);
      o.host(rec('f5c3' + ebc('HI')));
      vi.advanceTimersByTime(150);
      o.host(rec('f1c3' + ebc('I'))); // more output restarts the quiet period
      vi.advanceTimersByTime(150);
      expect(ready).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60);
      expect(ready).toHaveBeenCalledTimes(1);
      o.terminal(rec('7d4040'));
      vi.advanceTimersByTime(500);
      expect(ready).toHaveBeenCalledTimes(1); // locked: not ready
      o.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never emits ready without timers, and still tracks everything else', () => {
    const o = new SessionObserver();
    const ready = vi.fn();
    o.on('ready', ready);
    o.host(rec('f5c3' + ebc('HI')));
    expect(o.keyboardLocked).toBe(false);
    expect(ready).not.toHaveBeenCalled();
  });

  it('applies writes carried in Outbound 3270DS structured fields (OS/390 ISPF)', () => {
    const o = new SessionObserver();
    o.host(rec('f5c1'));
    o.terminal(rec('7d4040'));
    const ds = '00' + 'f1c3' + ebc('HI'); // partition 0, Write with keyboard restore
    o.host(rec('f3' + (ds.length / 2 + 3).toString(16).padStart(4, '0') + '40' + ds));
    expect(o.text[0]!.trim()).toBe('HI');
    expect(o.keyboardLocked).toBe(false);
  });
});
