/**
 * Query Reply: the terminal's answer to Read Partition Query / Query List,
 * describing what it supports. GA23-0059 §6. Each reply was checked byte for
 * byte against s3270 4.5ga6's for the same model, except RPQ Names (which
 * names 3270js) and DDM, which 3270js leaves out: it is how a host learns the
 * terminal can do IND$FILE file transfer, and 3270js can't.
 */
import { Aid } from '../inbound/aid.js';

/** Query Reply codes (QCODEs). */
export const QueryCode = {
  SUMMARY: 0x80,
  USABLE_AREA: 0x81,
  ALPHANUMERIC_PARTITIONS: 0x84,
  CHARACTER_SETS: 0x85,
  COLOR: 0x86,
  HIGHLIGHTING: 0x87,
  REPLY_MODES: 0x88,
  RPQ_NAMES: 0xa1,
  IMPLICIT_PARTITION: 0xa6,
  /** Sent alone when a Query List names nothing the terminal supports. */
  NULL: 0xff,
} as const;

export interface QueryReplyOptions {
  /** The terminal's maximum (alternate) size. */
  rows: number;
  cols: number;
  /** 3279 colour; otherwise a monochrome 3278. */
  color: boolean;
  /**
   * Query List (type List): only these replies, in the terminal's order; a
   * Null reply if none are supported (x3270 sf_read_part).
   */
  only?: readonly number[];
}

const QUERY_REPLY = 0x81;
const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 80;

/** The whole inbound record: AID X'88' followed by every reply. */
export function buildQueryReply(o: QueryReplyOptions): Uint8Array {
  const replies: [number, number[]][] = [
    [QueryCode.USABLE_AREA, usableArea(o)],
    [QueryCode.ALPHANUMERIC_PARTITIONS, alphanumericPartitions(o)],
    [QueryCode.CHARACTER_SETS, characterSets()],
    [QueryCode.COLOR, color(o.color)],
    [QueryCode.HIGHLIGHTING, highlighting()],
    [QueryCode.REPLY_MODES, replyModes()],
    [QueryCode.RPQ_NAMES, rpqNames()],
    [QueryCode.IMPLICIT_PARTITION, implicitPartition(o)],
  ];
  const all: [number, number[]][] = [
    [QueryCode.SUMMARY, [QueryCode.SUMMARY, ...replies.map(([code]) => code)]],
    ...replies,
  ];
  const chosen = o.only ? all.filter(([code]) => o.only!.includes(code)) : all;
  const out: number[] = [Aid.STRUCTURED_FIELD];
  if (chosen.length === 0) out.push(...reply(QueryCode.NULL, []));
  for (const [code, data] of chosen) out.push(...reply(code, data));
  return Uint8Array.from(out);
}

function reply(code: number, data: number[]): number[] {
  return [...u16(data.length + 4), QUERY_REPLY, code, ...data];
}

function usableArea(o: QueryReplyOptions): number[] {
  return [
    0x01, // 12/14-bit addressing allowed
    0x00, // no special features
    ...u16(o.cols), // width in cells
    ...u16(o.rows), // height in cells
    0x01, // units: millimetres
    ...u16(0x000a),
    ...u16(0x02e5), // Xr: horizontal distance between points (10/741 mm)
    ...u16(0x0002),
    ...u16(0x006f), // Yr: vertical distance between points (2/111 mm)
    0x09, // AW: cell width in units
    0x0c, // AH: cell height in units
    ...u16(o.rows * o.cols), // buffer size
  ];
}

function alphanumericPartitions(o: QueryReplyOptions): number[] {
  return [0x00, ...u16(o.rows * o.cols), 0x00]; // no partitions beyond the implicit one
}

function characterSets(): number[] {
  return [
    0x82, // flags: GE supported, CGCSGIDs included
    0x00,
    0x09, // default character slot width
    0x0c, // default character slot height
    0x00,
    0x00,
    0x00,
    0x00, // supported load PS formats: none
    0x07, // descriptor length
    // Set 0: the base set, CGCSGID 697/37.
    0x00,
    0x10,
    0x00,
    ...u16(697),
    ...u16(37),
    // Set 1: the APL (GE) set, LCID X'F1', CGCSGID 963/310.
    0x01,
    0x00,
    0xf1,
    ...u16(963),
    ...u16(310),
  ];
}

function color(isColor: boolean): number[] {
  // Pairs of (colour attribute value, colour the terminal shows). A monochrome
  // terminal shows only its default colour; a 3279 shows each colour as itself.
  const pairs: number[] = [0x00, 0xf4];
  for (let c = 0xf1; c <= 0xff; c++) pairs.push(c, isColor ? c : 0x00);
  return [0x00, 0x10, ...pairs];
}

function highlighting(): number[] {
  return [0x05, 0x00, 0xf0, 0xf1, 0xf1, 0xf2, 0xf2, 0xf4, 0xf4, 0xf8, 0xf8];
}

function replyModes(): number[] {
  return [0x00, 0x01, 0x02]; // field, extended field and character modes
}

/** The terminal's name, as x3270 reports "x3270": 3270js in EBCDIC. */
function rpqNames(): number[] {
  const name = [0xf3, 0xf2, 0xf7, 0xf0, 0x91, 0xa2]; // "3270js"
  return [
    ...[0x00, 0x00, 0x00, 0x00], // device
    ...[0x00, 0x00, 0x00, 0x00], // model
    name.length + 1,
    ...name,
  ];
}

function implicitPartition(o: QueryReplyOptions): number[] {
  return [
    0x00,
    0x00, // reserved
    0x0b,
    0x01,
    0x00, // self-defining parameter: implicit partition sizes
    ...u16(DEFAULT_COLS),
    ...u16(DEFAULT_ROWS),
    ...u16(o.cols),
    ...u16(o.rows),
  ];
}

function u16(n: number): [number, number] {
  return [(n >> 8) & 0xff, n & 0xff];
}
