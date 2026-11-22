// Fail if any committed trace contains a known default password, in ASCII or
// EBCDIC (CP037) hex. Recording redacts non-display fields, but a password
// typed into a visible field would not be caught by that.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PASSWORDS = ['CUL8TR', 'PASS4U', 'IBMPASS', 'SYS1', 'SECRET'];
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
  const text = readFileSync(f, 'utf8').toLowerCase();
  for (const [pw, needle] of needles) {
    if (text.includes(needle.toLowerCase())) {
      console.error(`${f}: contains password ${pw} (as "${needle}")`);
      bad++;
    }
  }
}
console.log(`checked ${files.length} trace/fixture files`);
process.exit(bad ? 1 : 0);
