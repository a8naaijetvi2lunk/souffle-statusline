#!/usr/bin/env node
// Visuels du README à partir du vrai rendu : page HTML → Chrome headless (PNG ×2) → GIF via ffmpeg.
// Usage : node scripts/capture.mjs   (CHROME_PATH et FFMPEG_PATH si absents du PATH)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sceneFrames } from '../src/preview.mjs';
import { emote } from '../src/statusline.mjs';
import { STRINGS } from '../src/i18n.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const OUT = path.join(ROOT, 'scripts', 'out');
const COLUMNS = 80;
const SIZE = { frame: [880, 290], states: [760, 290] };

const CAPTIONS = {
  en: { title: 'claude — ~/my-app', working: 'Claude is working', agents: 'subagents running, breathes twice as fast',
    yourTurn: 'reply done, for one minute', idle: 'waiting for you', asleep: 'after 10 minutes of inactivity', statesTitle: 'Souffle — states' },
  fr: { title: 'claude — ~/my-app', working: 'Claude travaille', agents: 'sous-agents actifs, respire deux fois plus vite',
    yourTurn: 'réponse terminée, pendant une minute', idle: 'en attente', asleep: 'après 10 minutes sans activité', statesTitle: 'Souffle — états' },
};
// Chaque état à son pic de respiration (image = demi-période).
const STATES = [
  ['working', { busy: true }, 4, 'working'], ['agents', { busy: true, agents: 2 }, 2, 'working'],
  ['yourTurn', { idleMs: 2_000 }, 4, 'yourTurn'], ['idle', { idleMs: 5 * 60_000 }, 6, 'idle'], ['asleep', { idleMs: 20 * 60_000 }, 10, 'asleep'],
];

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Sous-ensemble SGR émis par la statusline : 0 (reset), 1 (gras), 38;2;r;g;b (couleur).
function ansiToHtml(text) {
  let html = '', color = null, bold = false;
  for (const token of text.match(/\x1b\[[0-9;]*m|[^\x1b]+/g) || []) {
    if (!token.startsWith('\x1b[')) {
      const style = (color ? `color:rgb(${color.join(',')});` : '') + (bold ? 'font-weight:700;' : '');
      html += style ? `<span style="${style}">${escapeHtml(token)}</span>` : escapeHtml(token);
      continue;
    }
    const codes = token.slice(2, -1).split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] === 0) { color = null; bold = false; }
      else if (codes[i] === 1) bold = true;
      else if (codes[i] === 38 && codes[i + 1] === 2) { color = codes.slice(i + 2, i + 5); i += 4; }
    }
  }
  return html;
}

function page(lang, frames, states) {
  const c = CAPTIONS[lang];
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>Souffle</title>
<style>
  :root { --cols: ${COLUMNS}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: radial-gradient(900px 420px at 12% -10%, #3a2016 0%, transparent 62%),
                radial-gradient(800px 420px at 110% 120%, #132330 0%, transparent 58%), #0a0b0e;
    font-family: 'Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
  }
  .window { background: #0f1115; border: 1px solid #242830; border-radius: 12px; overflow: hidden; font-size: 15px;
    box-shadow: 0 28px 70px rgba(0, 0, 0, .6), inset 0 1px 0 rgba(255, 255, 255, .03); }
  .bar { height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: #171a20; border-bottom: 1px solid #1f232a; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .title { flex: 1; text-align: center; margin-right: 56px; color: #7b828c; font: 12.5px system-ui, 'Segoe UI', sans-serif; }
  .screen { padding: 14px 22px 16px; line-height: 1.55; color: #d5d8dc; white-space: pre; }
  .row { height: 1.55em; }
  .rule { color: #2d3239; }
  .prompt { color: #8b929b; }
  .cursor { display: inline-block; width: .6em; height: 1.1em; vertical-align: -.2em; background: #d5d8dc; opacity: .8; }
  .states { display: grid; grid-template-columns: max-content max-content; column-gap: 3ch; }
  .note { color: #565c64; }
</style></head>
<body><div class="window">
  <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="title" id="title"></span></div>
  <div class="screen" id="screen"></div>
</div>
<script>
  const FRAMES = ${JSON.stringify(frames)};
  const STATES = ${JSON.stringify(states)};
  const TITLES = ${JSON.stringify({ frame: c.title, states: c.statesTitle })};
  const params = new URLSearchParams(location.search);
  const view = params.get('view') || 'play';
  const screen = document.getElementById('screen');
  const rule = '─'.repeat(${COLUMNS});
  document.getElementById('title').textContent = view === 'states' ? TITLES.states : TITLES.frame;
  function frame(i) {
    screen.innerHTML = '<div class="row rule">' + rule + '</div><div class="row"><span class="prompt">&gt; </span><span class="cursor"></span></div>' +
      '<div class="row rule">' + rule + '</div>' + FRAMES[i].map((line) => '<div class="row">' + line + '</div>').join('');
  }
  if (view === 'states') {
    screen.innerHTML = '<div class="states">' + STATES.map(([line, note]) => '<div class="row">' + line + '</div><div class="row note"># ' + note + '</div>').join('') + '</div>';
  } else {
    let i = Number(params.get('frame') || 0);
    frame(i);
    if (view === 'play') setInterval(() => frame(i = (i + 1) % FRAMES.length), 1000);
  }
</script></body></html>
`;
}

function findTool(envName, candidates, probeArgs = ['--version']) {
  for (const candidate of [process.env[envName], ...candidates].filter(Boolean)) {
    const probe = spawnSync(candidate, probeArgs, { encoding: 'utf8', windowsHide: true });
    if (probe.status === 0 || fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${envName} not found; set ${envName}.`);
}

const chrome = findTool('CHROME_PATH', [
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'google-chrome', 'chromium', 'chromium-browser',
]);
const ffmpeg = findTool('FFMPEG_PATH', ['ffmpeg'], ['-version']);

// Profil Chrome jetable, partagé par toutes les captures (Chrome le verrouille encore un instant après sa sortie).
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'souffle-chrome-'));
process.on('exit', () => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* ménage best effort */ } });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const size = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };

// Sous Windows, le lanceur chrome.exe rend la main avant que le processus enfant n'écrive l'image : on attend un fichier stable.
async function shoot(file, url, [width, height]) {
  fs.rmSync(file, { force: true });
  const result = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--force-device-scale-factor=2',
    `--user-data-dir=${profile}`, `--window-size=${width},${height}`, `--screenshot=${file}`, url], { encoding: 'utf8', windowsHide: true });
  for (let waited = 0, last = -1; waited < 30_000; waited += 150) {
    const current = size(file);
    if (current > 0 && current === last) return;
    last = current;
    await sleep(150);
  }
  throw new Error('Chrome screenshot failed: ' + result.stderr);
}

function run(tool, args) {
  const result = spawnSync(tool, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
}

fs.mkdirSync(OUT, { recursive: true });
for (const lang of ['en', 'fr']) {
  const suffix = lang === 'en' ? '' : '-' + lang;
  const frames = (await sceneFrames({ lang, columns: COLUMNS })).map((text) => text.split('\n').map(ansiToHtml));
  const states = STATES.map(([key, state, period, label]) => [ansiToHtml(emote(state, period / 2, undefined, STRINGS[lang])).padEnd(0), CAPTIONS[lang][key], label]);
  const html = path.join(OUT, `capture${suffix}.html`);
  fs.writeFileSync(html, page(lang, frames, states));
  const url = pathToFileURL(html).href;

  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souffle-frames-'));
  for (let i = 0; i < frames.length; i++) await shoot(path.join(framesDir, `f${String(i).padStart(3, '0')}.png`), `${url}?view=frame&frame=${i}`, SIZE.frame);
  // Capture fixe : agents en renfort, au pic de respiration.
  fs.copyFileSync(path.join(framesDir, 'f015.png'), path.join(ASSETS, `screenshot${suffix}.png`));
  await shoot(path.join(ASSETS, `states${suffix}.png`), `${url}?view=states`, SIZE.states);
  run(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', '1', '-i', path.join(framesDir, 'f%03d.png'), '-vf',
    `scale=${SIZE.frame[0]}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    '-loop', '0', path.join(ASSETS, `demo${suffix}.gif`)]);
  fs.rmSync(framesDir, { recursive: true, force: true });
  console.log(`${lang}: ${frames.length} frames → assets/demo${suffix}.gif, screenshot${suffix}.png, states${suffix}.png`);
}
