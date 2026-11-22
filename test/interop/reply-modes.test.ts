/**
 * Reply modes and Read Partition reads: the bytes a client sends back for the
 * same screen must be what s3270 sends, byte for byte. Plain TN3270, so no
 * TN3270E headers are involved.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ebcdic,
  startTn3270eHost,
  type HostEvent,
  type StartedHost,
} from '../helpers/tn3270e-host.js';
import { CLIENTS, type InteropClient } from './clients.js';

const s3270 = CLIENTS.find((c) => c.name === 's3270')!;
const ours = CLIENTS.find((c) => c.name === '3270js')!;

/**
 * Erase/Write (keyboard restore): a protected red underlined field "HELLO"
 * with a turquoise "AB" (SA) and a reset "C"; an unprotected field with its
 * MDT set holding "XYZ" in yellow; a protected field with a GE box corner.
 */
const SCREEN = [
  0xf5,
  0xc3,
  0x11,
  0x40,
  0x40,
  0x29,
  0x03,
  0xc0,
  0x60,
  0x42,
  0xf2,
  0x41,
  0xf4,
  ...ebcdic('HELLO'),
  0x28,
  0x42,
  0xf5,
  ...ebcdic('AB'),
  0x28,
  0x00,
  0x00,
  ...ebcdic('C'),
  0x29,
  0x02,
  0xc0,
  0xc1,
  0x42,
  0xf6,
  ...ebcdic('XYZ'),
  0x1d,
  0x60,
  0x08,
  0xc5,
];
const RB = [0xf2];
const wsf = (...fields: number[][]) => [
  0xf3,
  ...fields.flatMap((f) => [(f.length + 2) >> 8, (f.length + 2) & 0xff, ...f]),
];
const setReplyMode = (mode: number, ...attrs: number[]) => wsf([0x09, 0x00, mode, ...attrs]);
const readPartition = (type: number) => wsf([0x01, 0x00, type]);

const isRecord = (e: HostEvent): e is Extract<HostEvent, { kind: 'record' }> => e.kind === 'record';

/** Run `records` against one client and return the hex of the first record it sends back. */
async function reply(factory: typeof s3270, records: number[][]): Promise<string> {
  const host: StartedHost = await startTn3270eHost({ tn3270e: false });
  const client: InteropClient = factory.create();
  try {
    const connected = client.connect(host.port);
    const s = await host.next();
    await s.waitFor((e) => e.kind === 'negotiated');
    for (const r of records) s.send3270(r);
    await connected;
    const r = await s.waitFor(isRecord);
    return Buffer.from(r.record.data).toString('hex');
  } finally {
    await client.close();
    await host.close();
  }
}

const cases: [string, number[][]][] = [
  ['Read Buffer, field mode', [SCREEN, RB]],
  ['Read Buffer, extended-field mode', [setReplyMode(0x01), SCREEN, RB]],
  [
    'Read Buffer, character mode (all attributes)',
    [setReplyMode(0x02, 0x41, 0x42, 0x43, 0x45), SCREEN, RB],
  ],
  ['Read Buffer, character mode (foreground only)', [setReplyMode(0x02, 0x42), SCREEN, RB]],
  [
    "Read Partition Read Buffer (AID X'61')",
    [setReplyMode(0x02, 0x42), SCREEN, readPartition(0xf2)],
  ],
  [
    'Read Partition Read Modified, character mode',
    [setReplyMode(0x02, 0x41, 0x42), SCREEN, readPartition(0xf6)],
  ],
  ['Read Partition Read Modified All', [SCREEN, readPartition(0x6e)]],
  [
    'Erase/Write with WCC reset returns to field mode',
    [setReplyMode(0x01), [...SCREEN.slice(0, 1), 0xc3 | 0x40, ...SCREEN.slice(2)], RB],
  ],
  ['Query List of Color and Reply Modes', [wsf([0x01, 0xff, 0x03, 0x00, 0x86, 0x88])]],
];

describe.skipIf(!s3270.available)('reply modes: 3270js sends what s3270 sends', () => {
  afterEach(() => undefined);
  for (const [name, records] of cases) {
    it(name, async () => {
      const theirs = await reply(s3270, records);
      const mine = await reply(ours, records);
      expect(mine).toBe(theirs);
    });
  }
});
