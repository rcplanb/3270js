// Verify every subpath export resolves under both require() and import.
import { createRequire } from 'node:module';
import pkg from '../package.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const subpaths = Object.keys(pkg.exports).filter((k) => k !== './package.json');
let failed = 0;

for (const sub of subpaths) {
  const spec = sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`;
  for (const [kind, load] of [
    ['require', () => require(spec)],
    ['import', () => import(spec)],
  ]) {
    try {
      await load();
      console.log(`ok   ${kind.padEnd(7)} ${spec}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${kind.padEnd(7)} ${spec}: ${err.message}`);
    }
  }
}
process.exit(failed ? 1 : 0);
