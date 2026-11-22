import { describe, expect, it } from 'vitest';
import {
  QueryCode,
  buildQueryReply,
  parseStructuredFields,
} from '../../../../src/core/query/index.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Split a query reply (after the 0x88 AID) into its structured fields, by QCODE. */
function replies(record: Uint8Array): Map<number, string> {
  expect(record[0]).toBe(0x88);
  const out = new Map<number, string>();
  let i = 1;
  while (i < record.length) {
    const len = (record[i]! << 8) | record[i + 1]!;
    expect(record[i + 2]).toBe(0x81); // Query Reply
    out.set(record[i + 3]!, hex(record.subarray(i, i + len)));
    i += len;
  }
  return out;
}

/**
 * What s3270 4.5ga6 sent TK5 as a 3278-2 (captured 2026-11-22). Our replies
 * must match these byte for byte, except Summary and Reply Modes (we claim
 * less) and the DDM and RPQ Names replies (which we don't send).
 */
const S3270_3278_2 = {
  usableArea: '0017818101000050001801000a02e50002006f090c0780',
  alphanumericPartitions: '0008818400078000',
  characterSets: '001b81858200090c000000000700100002b900250100f103c30136',
  color: '00268186001000f4f100f200f300f400f500f600f700f800f900fa00fb00fc00fd00fe00ff00',
  highlighting: '000f81870500f0f1f1f2f2f4f4f8f8',
  implicitPartition: '001181a600000b01000050001800500018',
};

describe('parseStructuredFields (GA23-0059 §5.1)', () => {
  it('parses the Read Partition Query TK5 sends', () => {
    expect(parseStructuredFields(Uint8Array.of(0x00, 0x05, 0x01, 0xff, 0x02))).toEqual({
      fields: [{ id: 0x01, data: Uint8Array.of(0xff, 0x02) }],
      errors: [],
    });
  });

  it('parses several fields, and a zero length meaning "the rest"', () => {
    const r = parseStructuredFields(
      Uint8Array.of(0x00, 0x04, 0x01, 0xaa, 0x00, 0x00, 0x40, 0x01, 0x02),
    );
    expect(r.fields.map((f) => [f.id, hex(f.data)])).toEqual([
      [0x01, 'aa'],
      [0x40, '0102'],
    ]);
  });

  it('reports malformed lengths', () => {
    expect(parseStructuredFields(Uint8Array.of(0x00)).errors[0]).toMatch(/length/);
    expect(parseStructuredFields(Uint8Array.of(0x00, 0x02, 0x01)).errors[0]).toMatch(/length/);
    expect(parseStructuredFields(Uint8Array.of(0x00, 0x09, 0x01)).errors[0]).toMatch(/length/);
  });
});

describe('buildQueryReply (GA23-0059 §6)', () => {
  const mono2 = replies(buildQueryReply({ rows: 24, cols: 80, color: false }));

  it('matches s3270’s replies for a 3278-2', () => {
    expect(mono2.get(QueryCode.USABLE_AREA)).toBe(S3270_3278_2.usableArea);
    expect(mono2.get(QueryCode.ALPHANUMERIC_PARTITIONS)).toBe(S3270_3278_2.alphanumericPartitions);
    expect(mono2.get(QueryCode.CHARACTER_SETS)).toBe(S3270_3278_2.characterSets);
    expect(mono2.get(QueryCode.COLOR)).toBe(S3270_3278_2.color);
    expect(mono2.get(QueryCode.HIGHLIGHTING)).toBe(S3270_3278_2.highlighting);
    expect(mono2.get(QueryCode.IMPLICIT_PARTITION)).toBe(S3270_3278_2.implicitPartition);
  });

  it('summarises exactly the replies it sends, with all three reply modes as s3270', () => {
    expect(mono2.get(QueryCode.SUMMARY)).toBe('000d8180' + '808184858687' + '88a1a6');
    expect(mono2.get(QueryCode.REPLY_MODES)).toBe('00078188000102'); // as s3270 4.5
    expect([...mono2.keys()]).toEqual([0x80, 0x81, 0x84, 0x85, 0x86, 0x87, 0x88, 0xa1, 0xa6]);
  });

  it('names itself in RPQ Names (s3270 says x3270), and leaves out DDM', () => {
    expect(mono2.get(QueryCode.RPQ_NAMES)).toBe(
      '001381a1' + '00000000' + '00000000' + '07f3f2f7f091a2',
    );
    expect(mono2.has(0x95)).toBe(false); // DDM: no IND$FILE file transfer
  });

  it('answers a Query List with only the replies named, or Null', () => {
    const only = (codes: number[]) => [
      ...replies(buildQueryReply({ rows: 24, cols: 80, color: false, only: codes })).keys(),
    ];
    expect(only([0x86, 0x81])).toEqual([0x81, 0x86]); // the terminal's order
    expect(only([0x99])).toEqual([0xff]); // nothing supported: Null
    expect(
      Buffer.from(buildQueryReply({ rows: 24, cols: 80, color: false, only: [] })).toString('hex'),
    ).toBe('88' + '000481ff');
  });

  it('describes the alternate size for larger models', () => {
    const m5 = replies(buildQueryReply({ rows: 27, cols: 132, color: false }));
    expect(m5.get(QueryCode.USABLE_AREA)!.slice(12, 20)).toBe('0084001b'); // 132 × 27
    expect(m5.get(QueryCode.USABLE_AREA)!.slice(-4)).toBe('0dec'); // 3564 cells
    expect(m5.get(QueryCode.IMPLICIT_PARTITION)).toBe('001181a600000b010000500018' + '0084001b');
  });

  it('advertises colours as s3270 does for a 3279 when colour is on', () => {
    // From s3270 as 3279-2-E against TK5 (captured 2026-11-22).
    const c = replies(buildQueryReply({ rows: 24, cols: 80, color: true }));
    expect(c.get(QueryCode.COLOR)).toBe(
      '00268186001000f4f1f1f2f2f3f3f4f4f5f5f6f6f7f7f8f8f9f9fafafbfbfcfcfdfdfefeffff',
    );
  });
});
