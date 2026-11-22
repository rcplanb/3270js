// Verify every subpath export resolves under both require() and import, and
// that the font assets resolve.
import { createRequire } from 'node:module';
import pkg from '../package.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const subpaths = Object.keys(pkg.exports).filter((k) => k !== './package.json' && !k.includes('*'));
let failed = 0;

// Asset exports (fonts/*): these files must resolve, though they aren't modules.
const ASSETS = ['fonts/3270.css', 'fonts/3270-Regular.woff2', 'fonts/3270-Regular.woff'];
for (const asset of ASSETS) {
  const spec = `${pkg.name}/${asset}`;
  try {
    require.resolve(spec);
    import.meta.resolve(spec);
    console.log(`ok   resolve ${spec}`);
  } catch (err) {
    failed++;
    console.error(`FAIL resolve ${spec}: ${err.message}`);
  }
}

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
