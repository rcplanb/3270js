// Fail if any committed trace or fixture contains a known TK5/MVS default
// password, in ASCII or EBCDIC (CP037) hex. Recording already redacts
// non-display fields; this catches a password typed into a visible field.
//
// In traces only what the terminal sent is scanned: that is where typed
// passwords appear, and host output is full of names like SYS1.PROCLIB.
// IBMUSER's default password, SYS1, can't be scanned for at all (it is the
// prefix of every system data set name, which people type too); its
// protection is the non-display redaction.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PASSWORDS = ['CUL8TR', 'PASS4U', 'IBMPASS', 'SECRET'];
const EBCDIC = {
  A: 'c1',
  B: 'c2',
  C: 'c3',
  D: 'c4',
  E: 'c5',
  F: 'c6',
  G: 'c7',
  H: 'c8',
  I: 'c9',
  J: 'd1',
  K: 'd2',
  L: 'd3',
  M: 'd4',
  N: 'd5',
  O: 'd6',
  P: 'd7',
  Q: 'd8',
  R: 'd9',
  S: 'e2',
  T: 'e3',
  U: 'e4',
  V: 'e5',
  W: 'e6',
  X: 'e7',
  Y: 'e8',
  Z: 'e9',
  0: 'f0',
  1: 'f1',
  2: 'f2',
  3: 'f3',
  4: 'f4',
  5: 'f5',
  6: 'f6',
  7: 'f7',
  8: 'f8',
  9: 'f9',
};
const needles = PASSWORDS.flatMap((p) => [
  [p, p.toLowerCase()],
  [p, [...p].map((c) => EBCDIC[c]).join('')],
  [p, Buffer.from(p).toString('hex')],
]);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.json')) files.push(p);
  }
};
for (const dir of ['test/traces', 'test/fixtures']) walk(dir);

let bad = 0;
for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  const json = JSON.parse(raw);
  const text = (
    json.format === '3270js-trace'
      ? json.events
          .filter((e) => e.dir === 'terminal')
          .map((e) => e.hex)
          .join(' ')
      : raw
  ).toLowerCase();
  for (const [pw, needle] of needles) {
    if (text.includes(needle.toLowerCase())) {
      console.error(`${f}: contains password ${pw} (as "${needle}")`);
      bad++;
    }
  }
}
console.log(`checked ${files.length} trace/fixture files`);
process.exit(bad ? 1 : 0);
