// The 3270js session player: replays a trace into a real 3270 renderer.
// ?trace=tk5/ispf-tour-3279 plays /traces/tk5/ispf-tour-3279.json;
// ?renderer=canvas; ?speed=5; ?autoplay. "Open trace" reads a local file
// in the browser (nothing is uploaded).
import { CanvasRenderer } from './dist/canvas.js';
import { DomRenderer } from './dist/dom.js';
import { TracePlayer } from './dist/player.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const Kind = params.get('renderer') === 'canvas' ? CanvasRenderer : DomRenderer;
const renderer = new Kind($('terminal'), { fontSize: 17 });
let player;

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function show() {
  $('position').textContent =
    `${fmt(player.time)} / ${fmt(player.duration)} · screen ${player.frame + 1} of ${player.frames}`;
  $('seek').value = String(Math.max(0, player.frame));
  $('play').textContent = player.playing ? 'Pause' : 'Play';
}

function load(trace, name) {
  player?.dispose();
  player = new TracePlayer(trace, { view: renderer, speed: Number($('speed').value) });
  window.__player = player; // for tests and the console
  player.on('frame', show);
  player.on('state', show);
  $('seek').max = String(Math.max(0, player.frames - 1));
  $('seek').disabled = $('play').disabled = false;
  $('status').textContent = `${name}: ${trace.meta.description ?? ''} (${trace.meta.terminalType})`;
  player.seekFrame(0);
  show();
  if (params.has('autoplay')) player.play();
}

$('play').onclick = () => (player.playing ? player.pause() : player.play());
$('speed').onchange = () => player && (player.speed = Number($('speed').value));
$('seek').oninput = () => {
  player.seekFrame(Number($('seek').value));
  show();
};
$('file').onchange = async () => {
  const file = $('file').files[0];
  if (!file) return;
  try {
    load(JSON.parse(await file.text()), file.name);
  } catch (e) {
    $('status').textContent = `Can't play ${file.name}: ${e.message}`;
  }
};

if (params.has('speed')) $('speed').value = params.get('speed');
const name = params.get('trace');
if (name && /^[\w./-]+$/.test(name) && !name.includes('..')) {
  const res = await fetch(`traces/${name}.json`);
  if (res.ok) load(await res.json(), name);
  else $('status').textContent = `No trace "${name}".`;
} else {
  $('status').textContent = 'Open a trace to play it.';
}
