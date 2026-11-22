import { Terminal, createTraceRecorder } from './dist/index.js';
import { DomRenderer, KeyboardMapper } from './dist/dom.js';
import { WebSocketTransport } from './dist/websocket.js';

const $ = (id) => document.getElementById(id);
const status = (msg) => ($('status').textContent = msg);

const KEYS = [
  ['Enter', 'Enter'],
  ['New Line', 'Shift+Enter'],
  ['PF1–12', 'F1–F12'],
  ['PF13–24', 'Shift+F1–F12'],
  ['PA1–3', 'Alt+1–3'],
  ['Clear', 'Esc'],
  ['Reset', 'Ctrl+R'],
  ['Attn', 'Alt+A'],
  ['SysReq', 'Alt+S'],
  ['Erase EOF', 'End'],
  ['Erase Input', 'Ctrl+End'],
  ['Insert', 'Insert'],
  ['Dup', 'Alt+D'],
  ['Field Mark', 'Alt+F'],
];
$('keys').innerHTML = KEYS.map(
  ([k, v]) =>
    `<tr><td>${k}</td><td>${v
      .split(/(?<=\S)(?=\+)|(?<=\+)/)
      .map((p) => (p === '+' ? '+' : `<kbd>${p}</kbd>`))
      .join('')}</td></tr>`,
).join('');

const targets = await (await fetch('targets.json')).json();
$('target').innerHTML = Object.entries(targets)
  .map(([k, v]) => `<option value="${k}">${k} (${v})</option>`)
  .join('');

let session; // { term, renderer, mapper, recorder }

function disconnect() {
  if (!session) return;
  session.term.disconnect();
}

function teardown() {
  session?.mapper.dispose();
  session = undefined;
  $('connect').textContent = 'Connect';
  $('trace').disabled = true;
}

async function connect() {
  const model = Number($('model').value);
  const color = $('color').checked;
  const term = new Terminal({ model, color, keyboard: { blankFill: $('blankfill').checked } });
  $('terminal').replaceChildren();
  const renderer = new DomRenderer($('terminal'), {
    displayMode: color ? 'color' : $('display').value,
    oiaGlyphs: $('glyphs').checked,
  });
  $('display').value = color ? 'color' : $('display').value;
  renderer.attach(term);
  const mapper = new KeyboardMapper(term, renderer);
  const recorder = createTraceRecorder({
    meta: {
      terminalType: term.terminalType,
      model,
      codePage: term.codePage.id,
      description: 'demo session',
      recorded: new Date().toISOString(),
    },
  });
  recorder.attach(term);
  session = { term, renderer, mapper, recorder };
  term.on('disconnect', (e) => {
    status(`Disconnected${e.reason ? `: ${e.reason}` : ''}.`);
    teardown();
  });
  term.on('error', (e) => console.warn('3270:', e.message));
  term.on('alarm', () =>
    renderer.element.animate([{ filter: 'brightness(2)' }, { filter: 'none' }], 200),
  );

  $('connect').textContent = 'Disconnect';
  $('trace').disabled = false;
  status(`Connecting to ${$('target').value} as ${term.terminalType}…`);
  try {
    await term.connect(
      new WebSocketTransport(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/tn3270?target=${encodeURIComponent($('target').value)}`,
      ),
    );
    status(`Connected as ${term.terminalType}.`);
    mapper.focus();
  } catch (e) {
    status(String(e.message ?? e));
    teardown();
  }
}

$('connect').onclick = () => (session ? disconnect() : connect());
$('display').onchange = () => session?.renderer.setDisplayMode($('display').value);
$('glyphs').onchange = () => {
  if (!session) return;
  // Recreate the renderer with the new option, keeping the session.
  const { term, renderer, mapper } = session;
  mapper.dispose();
  renderer.dispose();
  const r = new DomRenderer($('terminal'), {
    displayMode: $('display').value,
    oiaGlyphs: $('glyphs').checked,
  });
  r.attach(term);
  session.renderer = r;
  session.mapper = new KeyboardMapper(term, r);
  session.mapper.focus();
};
$('trace').onclick = () => {
  if (!session) return;
  const blob = new Blob([JSON.stringify(session.recorder.trace(), null, 1)], {
    type: 'application/json',
  });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `3270js-trace-${Date.now()}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
};

// ?autoconnect connects on load; ?color=1 / ?model=N preset the options.
const params = new URLSearchParams(location.search);
if (params.has('model')) $('model').value = params.get('model');
if (params.get('color') === '1') $('color').checked = true;
if (params.has('autoconnect')) void connect();
