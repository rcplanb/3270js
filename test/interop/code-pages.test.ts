/**
 * Code pages against s3270 (-codepage): every graphic byte X'41'-X'FE' shows
 * as the same character, and the Query Reply names the same CGCSGID.
 */
import { describe, expect, it } from 'vitest';
import { Terminal } from '../../src/core/terminal.js';
import { TcpTransport } from '../../src/transport/node/tcp.js';
import { S3270, s3270Available } from '../differential/s3270.js';
import { type HostEvent, startTn3270eHost } from '../helpers/tn3270e-host.js';

const isRecord = (e: HostEvent): e is Extract<HostEvent, { kind: 'record' }> => e.kind === 'record';
const settle = () => new Promise((r) => setTimeout(r, 150));

/** Erase/Write: bytes X'41'-X'FE' in an unformatted screen, 80 to a row. */
const ALL_GRAPHICS = [0xf5, 0xc3, ...Array.from({ length: 0xfe - 0x40 }, (_, i) => 0x41 + i)];
/** Query List: Character Sets only. */
const QUERY_CHARSETS = [0xf3, 0x00, 0x07, 0x01, 0xff, 0x03, 0x00, 0x85];

async function run(client: 's3270' | '3270js', codePage: string) {
  const host = await startTn3270eHost({ tn3270e: false });
  const s3 = client === 's3270' ? new S3270(['-codepage', codePage], '3279-2') : undefined;
  const term = client === '3270js' ? new Terminal({ color: true, codePage }) : undefined;
  try {
    if (s3) void s3.run(`Connect(127.0.0.1:${host.port})`).catch(() => undefined);
    else
      void term!
        .connect(new TcpTransport({ host: '127.0.0.1', port: host.port }))
        .catch(() => undefined);
    const s = await host.next();
    await s.waitFor((e) => e.kind === 'negotiated');
    s.send3270(ALL_GRAPHICS);
    await settle();
    const text = s3 ? (await s3.run('Ascii(0,0,3,80)')).join('') : term!.text.slice(0, 3).join('');
    s.send3270(QUERY_CHARSETS);
    const reply = await s.waitFor(isRecord);
    return {
      text: text.slice(0, 0xfe - 0x40),
      charsets: Buffer.from(reply.record.data).toString('hex'),
    };
  } finally {
    s3?.kill();
    term?.disconnect();
    await host.close();
  }
}

describe.skipIf(!s3270Available())('code pages: 3270js shows and reports what s3270 does', () => {
  // A character that tells each page apart, so a silent fallback to CP037 can't pass.
  const marks: [string, number, string, string][] = [
    ['cp037', 0x4a, '¢', '02b90025'],
    ['cp1047', 0xad, '[', '02b90417'],
    ['cp500', 0x4a, '[', '02b901f4'],
    ['cp285', 0x5b, '£', '02b9011d'],
    ['cp1140', 0x9f, '€', '02b70474'],
  ];
  for (const [cp, byte, char, cgcsgid] of marks) {
    it(`${cp} (X'${byte.toString(16).toUpperCase()}' is ${char})`, async () => {
      const theirs = await run('s3270', cp);
      const mine = await run('3270js', cp);
      expect(mine.text).toBe(theirs.text);
      expect(mine.text[byte - 0x41]).toBe(char);
      expect(mine.charsets).toBe(theirs.charsets);
      expect(mine.charsets).toContain(cgcsgid);
    });
  }
});
