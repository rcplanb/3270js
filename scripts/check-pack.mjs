// Pack 3270js and install the tarball into an empty CommonJS project, as
// SimH Assist does (vendored "file:" dependency), then load every entry point
// with require and import, resolve the fonts, and run a small smoke test.
//
//   npm run build && node scripts/check-pack.mjs            (current Node)
//   NODE=~/.nvm/versions/node/v20.20.2/bin/node npm run check:pack
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const node = process.env.NODE ?? process.execPath;
const npm = join(dirname(node), 'npm');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), '3270js-pack-'));
try {
  const tgz = execFileSync(npm, ['pack', '--silent', '--pack-destination', work], {
    cwd: root,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .pop();
  const app = join(work, 'app');
  execFileSync('mkdir', ['-p', app]);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'app', private: true, type: 'commonjs' }),
  );
  // ws: 3270js/node needs it (SimH Assist has it); see issue "Load ws only for the proxy".
  execFileSync(npm, ['install', '--no-audit', '--no-fund', '--silent', join(work, tgz), 'ws@8'], {
    cwd: app,
  });
  const entries = ['', '/dom', '/canvas', '/websocket', '/node', '/script', '/cast', '/player'];
  const check = `
    const assert = require('node:assert');
    const names = ${JSON.stringify(entries)}.map((e) => '3270js' + e);
    for (const n of names) assert.ok(Object.keys(require(n)).length, n);
    for (const f of ['3270.css', '3270-Regular.woff2', '3270-Regular.woff']) require.resolve('3270js/fonts/' + f);
    const { Terminal, SessionObserver, applyAction, recognise } = require('3270js');
    const { traceToCast } = require('3270js/cast');
    const t = new Terminal({ model: 2, color: true });
    assert.strictEqual(t.deviceType, 'IBM-3278-2-E');
    const o = new SessionObserver();
    o.host(Buffer.from('f5c3c8c9ffef', 'hex'));
    assert.strictEqual(o.text[0].trim(), 'HI');
    assert.strictEqual(recognise(o).kind, 'unknown');
    assert.deepStrictEqual(applyAction(t, { aid: 'PF3' }).reason, 'not-connected');
    const cast = traceToCast({ format: '3270js-trace', version: 1, meta: { terminalType: 'IBM-3279-2-E', model: 2, codePage: 'cp037' }, events: [] });
    assert.ok(cast.startsWith('{"version":2'));
    Promise.all(names.map((n) => import(n))).then((ms) => {
      assert.ok(ms.every((m) => Object.keys(m).length));
      console.log('ok: ' + names.length + ' entry points (require and import), fonts, smoke test');
    });
  `;
  const out = execFileSync(node, ['-e', check], { cwd: app, encoding: 'utf8' });
  console.log(
    `${pkg.name}@${pkg.version} (${tgz}) on Node ${execFileSync(node, ['-v'], { encoding: 'utf8' }).trim()}: ${out.trim()}`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
