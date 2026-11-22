/**
 * Passwords must be redacted in TN3270E sessions too. Before this test, the
 * recorder fed TN3270E records (with their 5-byte header) straight into its
 * shadow screen, never learned which fields were hidden, and a password typed
 * on OS/390 2.10 reached the trace.
 */
import { describe, expect, it } from 'vitest';
import { Terminal } from '../../../../src/core/terminal.js';
import { createTraceRecorder } from '../../../../src/core/trace/index.js';
import { FakeHost, frame } from '../../../helpers/fake-host.js';

const ascii = (t: string) => Buffer.from(t, 'latin1').toString('hex');
/** OS/390 2.10's TN3270E negotiation (LU SC0TCP01; BIND-IMAGE, RESPONSES, SYSREQ). */
const NEGOTIATION = [
  'fffd28',
  'fffa280802fff0',
  `fffa280204${ascii('IBM-3278-2-E')}01${ascii('SC0TCP01')}fff0`,
  'fffa280304000204fff0',
];
const BIND = '03000000003101030391903080008487f88000028000000000185000007e000006e3c5d3d5c5e300';
/** Orders: a hidden unprotected field at 0 (cursor in it), protected field at 9. */
const PASSWORD_SCREEN = 'f5c3' + '1d4c' + '13' + '1140c9' + '1d60';
const SYS1 = 'a2a8a2f1'; // "sys1", as typed

function session() {
  const host = new FakeHost();
  const term = new Terminal();
  const recorder = createTraceRecorder({
    meta: { terminalType: term.terminalType, model: 2, codePage: 'cp037' },
  });
  recorder.attach(term);
  void term.connect(host);
  for (const c of NEGOTIATION) host.write(c);
  host.write(frame(BIND));
  return { host, term, recorder };
}

const sentRecords = (recorder: ReturnType<typeof createTraceRecorder>) =>
  recorder
    .trace()
    .events.filter((e) => e.dir === 'terminal' && e.kind === 'record')
    .map((e) => e.hex);

describe('trace redaction over TN3270E', () => {
  it('redacts a password typed into a hidden field, keeping the header', () => {
    const { host, term, recorder } = session();
    host.write(frame('0000000000' + PASSWORD_SCREEN));
    term.type('sys1');
    term.aid('ENTER');
    const [rec] = sentRecords(recorder);
    expect(rec).toBeDefined();
    expect(rec).not.toContain(SYS1);
    expect(rec!.startsWith('0000000000' + '7d')).toBe(true); // header, then the Enter AID
    expect(rec).toContain('5c5c5c5c'); // asterisks in its place
  });

  it('knows a field is hidden when ISPF defines it in an Outbound 3270DS structured field', () => {
    const { host, term, recorder } = session();
    const ds = '00' + PASSWORD_SCREEN.replace(/^f5/, 'f1'); // partition 0, Write
    const sf = (ds.length / 2 + 3).toString(16).padStart(4, '0') + '40' + ds;
    host.write(frame('0000000000' + 'f3' + sf));
    term.screen.cursor = 1;
    term.type('sys1');
    term.aid('ENTER');
    const [rec] = sentRecords(recorder);
    expect(rec).not.toContain(SYS1);
    expect(rec).toContain('5c5c5c5c');
  });

  it('leaves non-hidden input alone', () => {
    const { host, term, recorder } = session();
    host.write(frame('0000000000' + 'f5c3' + '1d40' + '13' + '1140c9' + '1d60'));
    term.type('sys1');
    term.aid('ENTER');
    expect(sentRecords(recorder)[0]).toContain(SYS1);
  });
});
