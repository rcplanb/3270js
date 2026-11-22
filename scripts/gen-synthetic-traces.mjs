// Generate synthetic traces for screens no host we have sends: TK5's recorded
// telnet negotiation, then hand-built 3270 records. Usage:
//   npm run build && node scripts/gen-synthetic-traces.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cp037, encodeAddress } from '../dist/index.js';

const root = resolve(import.meta.dirname, '..');
const tk5 = JSON.parse(readFileSync(resolve(root, 'test/traces/tk5/tso-logon.json'), 'utf8'));
const negotiation = tk5.events.slice(
  0,
  tk5.events.findIndex((e) => e.kind === 'record'),
);

const at = (row, col) => [0x11, ...encodeAddress(row * 80 + col, '12bit')];
const text = (s) => [...cp037.encode(s)];
const sf = (fa) => [0x1d, fa];
const sfe = (...pairs) => [0x29, pairs.length / 2, ...pairs];
const PROT = 0x60;
const UNPROT = 0x40;
const RED = 0xf2;

/** Fields with each outlining combination, and opaque/transparent backgrounds. */
const outlining = [
  0xf5,
  0xc3, // Erase/Write, WCC: reset, restore keyboard
  ...at(0, 30),
  ...sf(PROT | 0x08),
  ...text('FIELD OUTLINING'),
  ...sf(PROT),
  ...at(2, 2),
  ...sf(PROT),
  ...text('Box (all four)'),
  ...at(2, 24),
  ...sfe(0xc0, UNPROT, 0xc2, 0x0f),
  ...text('BOXED INPUT'),
  ...at(2, 40),
  ...sf(PROT),
  ...at(4, 2),
  ...sf(PROT),
  ...text('Underline'),
  ...at(4, 24),
  ...sfe(0xc0, UNPROT, 0xc2, 0x01),
  ...text('UNDER'),
  ...at(4, 40),
  ...sf(PROT),
  ...at(6, 2),
  ...sf(PROT),
  ...text('Over + under'),
  ...at(6, 24),
  ...sfe(0xc0, UNPROT, 0xc2, 0x05),
  ...text('RULED'),
  ...at(6, 40),
  ...sf(PROT),
  ...at(8, 2),
  ...sf(PROT),
  ...text('Left + right'),
  ...at(8, 24),
  ...sfe(0xc0, UNPROT, 0xc2, 0x0a),
  ...text('BRACKETED'),
  ...at(8, 40),
  ...sf(PROT),
  ...at(11, 2),
  ...sf(PROT),
  ...text('Opaque red bg'),
  ...at(11, 24),
  ...sfe(0xc0, PROT, 0x45, RED),
  ...text('BACKGROUND'),
  ...sf(PROT),
  ...at(13, 2),
  ...sf(PROT),
  ...text('Transparent'),
  ...at(13, 24),
  ...sfe(0xc0, PROT, 0x45, RED, 0x46, 0xf0),
  ...text('BACKGROUND'),
  ...sf(PROT),
  ...at(2, 25), // cursor into the boxed field
  0x13,
];

const trace = {
  format: '3270js-trace',
  version: 1,
  meta: {
    terminalType: 'IBM-3279-2-E',
    model: 2,
    codePage: 'cp037',
    description: 'Synthetic: field outlining and transparency (scripts/gen-synthetic-traces.mjs)',
  },
  events: [
    ...negotiation,
    { t: 0, dir: 'host', kind: 'record', hex: Buffer.from(outlining).toString('hex') },
  ],
};
writeFileSync(
  resolve(root, 'test/traces/synthetic/outlining.json'),
  JSON.stringify(trace, null, 1) + '\n',
);
console.log('wrote test/traces/synthetic/outlining.json');
