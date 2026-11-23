/**
 * Terminal.adopt: a Terminal that takes over an observed session on the same
 * connection. On every recorded trace, at every key the operator pressed:
 * adopt from the observer, then check that the adopted terminal shows the
 * same screen, keeps in step with the host until the next key, and (when the
 * key sent no typed data) sends exactly the bytes the real terminal sent,
 * TN3270E sequence number included.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Aid,
  type AidKey,
  encodeInbound,
  parseInbound,
} from '../../../../src/core/inbound/index.js';
import { SessionObserver } from '../../../../src/core/observer/index.js';
import type { Screen } from '../../../../src/core/screen/index.js';
import { frameRecord } from '../../../../src/core/telnet/index.js';
import { Terminal } from '../../../../src/core/terminal.js';
import type { Trace } from '../../../../src/core/trace/index.js';
import { FakeHost, frame } from '../../../helpers/fake-host.js';

const root = new URL('../../../traces/', import.meta.url);
const traces = readdirSync(root, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.json'));

function snapshot(s: Screen): string {
  const cells: string[] = [];
  for (let a = 0; a < s.size; a++) {
    const x = s.attributesAt(a);
    cells.push(`${s.fieldAttributeAt(a) ?? '-'}:${s.charAt(a)}:${x.foreground}:${x.highlighting}`);
  }
  return `${s.rows}x${s.cols}@${s.cursor}|${cells.join(',')}`;
}

const KEY_FOR_AID = new Map<number, AidKey>(
  Object.entries(Aid)
    .filter(([k]) => !['NONE', 'QUERY_REPLY', 'STRUCTURED_FIELD'].includes(k))
    .map(([k, v]) => [v, k as AidKey]),
);
const bytesOf = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

const totals = { adopted: 0, keysMatched: 0 };

describe('Terminal.adopt continues every recorded trace', () => {
  it.each(traces)('%s', (name) => {
    const trace = JSON.parse(readFileSync(new URL(name, root), 'utf8')) as Trace;
    const color = /3279/.test(trace.meta.terminalType);
    const observer = new SessionObserver({
      model: trace.meta.model,
      codePage: trace.meta.codePage,
      color,
    });
    const events = trace.events;
    let adopted = 0;
    let keysMatched = 0;
    for (let k = 0; k < events.length; k++) {
      const e = events[k]!;
      const chunk = bytesOf(e.kind === 'record' ? frame(e.hex) : e.hex);
      const isKey =
        e.dir === 'terminal' &&
        e.kind === 'record' &&
        observer.sessionMode === 'lu-lu' &&
        !observer.keyboardLocked;
      if (isKey) {
        // Adopt just before the operator's key.
        const host = new FakeHost();
        const term = Terminal.adopt(observer, host);
        adopted++;
        expect(term.connected, `${name} @${k}`).toBe(true);
        expect(snapshot(term.screen), `${name} @${k}`).toBe(snapshot(observer.screen));
        expect(term.keyboard.isLocked).toBe(false);
        expect(Boolean(term.tn3270e)).toBe(observer.tn3270e);

        // A key that sent no typed data: the adopted terminal sends the same record.
        const record = bytesOf(e.hex);
        const body = observer.tn3270e ? record.subarray(5) : record;
        const parsed = parseInbound(body, observer.screen.size);
        const key = KEY_FOR_AID.get(parsed.aid);
        if (key && parsed.fields.length === 0 && parsed.errors.length === 0) {
          term.moveCursor(parsed.cursor ?? term.screen.cursor);
          expect(term.aid(key).accepted).toBe(true);
          expect(host.takeSent(), `${name} @${k} ${key}`).toBe(frame(e.hex));
          keysMatched++;
        }
      }
      if (e.dir === 'terminal') observer.terminal(chunk);
      else observer.host(chunk);
    }
    totals.adopted += adopted;
    totals.keysMatched += keysMatched;
  });

  it('took over at many keys, and matched the bytes of key presses', () => {
    expect(totals.adopted).toBeGreaterThan(20);
    expect(totals.keysMatched).toBeGreaterThan(10);
  });

  it('continues the TN3270E sequence numbers', () => {
    const trace = JSON.parse(
      readFileSync(new URL('os390/tso-logon-unanswered.json', root), 'utf8'),
    ) as Trace;
    const observer = new SessionObserver({ model: 2, color: true });
    const events = trace.events;
    const key = events.findIndex((e) => e.dir === 'terminal' && e.kind === 'record');
    for (const e of events.slice(0, key)) {
      const chunk = bytesOf(e.kind === 'record' ? frame(e.hex) : e.hex);
      if (e.dir === 'terminal') observer.terminal(chunk);
      else observer.host(chunk);
    }
    expect(observer.tn3270e).toBe(true);
    const seq = events[key]!.hex.slice(6, 10); // the real terminal's sequence number
    const host = new FakeHost();
    const term = Terminal.adopt(observer, host);
    expect(term.tn3270e?.deviceType).toMatch(/^IBM-327/);
    expect(term.aid('PA1').accepted).toBe(true);
    expect(host.takeSent()).toBe(frame(`000000${seq}6c`));
    // After the real key, the next record counts on from it.
    observer.terminal(bytesOf(frame(events[key]!.hex)));
    expect(observer.session.nextSeq).toBe((parseInt(seq, 16) + 1) % 32768);
  });

  it('keeps in step with the host after taking over', () => {
    const name = traces.find((t) => t.includes('tk5'))!;
    const trace = JSON.parse(readFileSync(new URL(name, root), 'utf8')) as Trace;
    const observer = new SessionObserver({
      model: trace.meta.model,
      codePage: trace.meta.codePage,
    });
    const events = trace.events;
    // Take over halfway, at a point where the host is about to write.
    const half = events.findIndex(
      (e, i) => i > events.length / 2 && e.dir === 'host' && e.kind === 'record',
    );
    for (const e of events.slice(0, half)) {
      const chunk = bytesOf(e.kind === 'record' ? frame(e.hex) : e.hex);
      if (e.dir === 'terminal') observer.terminal(chunk);
      else observer.host(chunk);
    }
    const host = new FakeHost();
    const term = Terminal.adopt(observer, host);
    // From here on only host writes are compared, up to the next operator key.
    for (const e of events.slice(half)) {
      if (e.dir === 'terminal') break;
      const chunk = bytesOf(e.kind === 'record' ? frame(e.hex) : e.hex);
      observer.host(chunk);
      host.write(chunk);
      expect(snapshot(term.screen)).toBe(snapshot(observer.screen));
    }
  });
});

describe('encodeInbound and frameRecord', () => {
  it('round-trips through parseInbound', () => {
    const input = {
      aid: Aid.ENTER,
      cursor: 1000,
      fields: [
        { address: 81, data: Uint8Array.of(0xc8, 0xc5, 0xd9, 0xc3) },
        { address: 900, data: Uint8Array.of(0x5c, 0x5c) },
      ],
    };
    for (const size of [1920, 3564]) {
      const parsed = parseInbound(encodeInbound(input, size), size);
      expect(parsed.errors).toEqual([]);
      expect(parsed.aid).toBe(Aid.ENTER);
      expect(parsed.cursor).toBe(1000);
      expect(parsed.fields.map((f) => [f.address, [...f.data]])).toEqual(
        input.fields.map((f) => [f.address, [...f.data]]),
      );
    }
  });

  it('sends only the AID for PA keys and Clear', () => {
    expect([...encodeInbound({ aid: Aid.PA1, cursor: 5 }, 1920)]).toEqual([Aid.PA1]);
  });

  it('frames with IAC doubled and a TN3270E header', () => {
    expect(Buffer.from(frameRecord(Uint8Array.of(0x7d, 0xff))).toString('hex')).toBe('7dffffffef');
    const h = { dataType: 0, requestFlag: 0, responseFlag: 0, seq: 0x0102 };
    expect(Buffer.from(frameRecord(Uint8Array.of(0x6c), h)).toString('hex')).toBe(
      '00000001026cffef',
    );
  });
});
