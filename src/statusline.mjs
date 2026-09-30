#!/usr/bin/env node
// Souffle — statusline Claude Code sur trois lignes, relancée chaque seconde (refreshInterval 1).
// Ligne 1 : modèle · réflexion · dossier · durée. Ligne 2 : contexte | quota 5 h | quota hebdo.
// Ligne 3 : étincelle qui respire selon l'activité, agents actifs, hooks configurés.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRINGS, detectLang } from './i18n.mjs';
import { configDir, readActivity, readAgents, safeText } from './state.mjs';

// ────────── Réglages ──────────
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_BARS = '▁▂▃▄▅';
const EMOTE = '✻';
const BUSY_TTL_MS = 3 * 60 * 1000; // tour sans Stop (interruption) : retour au repos
const DONE_MS = 60 * 1000;         // « à toi » pendant une minute après la fin d'un tour
const SLEEP_MS = 10 * 60 * 1000;   // en veille au-delà

// Couleurs RVB, converties selon ce que le terminal accepte.
const RGB = {
  mute: [139, 146, 155], dim: [86, 92, 100], track: [46, 50, 56],
  ok: [95, 211, 138], warn: [233, 196, 106], crit: [242, 105, 106],
  cyan: [108, 199, 224], clawd: [215, 119, 87],
};
const MODEL_STYLES = [
  { re: /fable|mythos/i, icon: '✦', rgb: [255, 154, 87] },
  { re: /opus/i, icon: '◆', rgb: [111, 208, 140] },
  { re: /sonnet/i, icon: '●', rgb: [135, 215, 255] },
  { re: /haiku/i, icon: '○', rgb: [196, 155, 243] },
];
const EFFORT_RGB = [RGB.mute, [134, 168, 231], RGB.cyan, [196, 155, 243], [255, 154, 87]];
// Respiration de l'étincelle : [creux, pic] par état.
const BREATH = {
  clawd: [[120, 64, 48], [245, 160, 120]],
  ok: [[38, 92, 60], [95, 211, 138]],
  idle: [[96, 56, 44], [200, 112, 82]],
  sleep: [[50, 54, 60], [110, 116, 124]],
};

export function colorMode(env = process.env) {
  if (env.NO_COLOR) return 'none';
  const forced = String(env.SOUFFLE_COLOR || '').toLowerCase();
  if (['truecolor', '256', 'none'].includes(forced)) return forced;
  return env.TERM_PROGRAM === 'Apple_Terminal' ? '256' : 'truecolor';
}

function to256([r, g, b]) {
  if (r === g && g === b) return r < 8 ? 16 : r > 248 ? 231 : Math.round((r - 8) / 247 * 24) + 232;
  const q = (c) => Math.round(c / 255 * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function painter(mode) {
  const fg = (rgb) => mode === 'none' ? '' : mode === '256' ? `\x1b[38;5;${to256(rgb)}m` : `\x1b[38;2;${rgb.join(';')}m`;
  const c = Object.fromEntries(Object.entries(RGB).map(([name, rgb]) => [name, fg(rgb)]));
  return { ...c, fg, reset: mode === 'none' ? '' : '\x1b[0m', bold: mode === 'none' ? '' : '\x1b[1m' };
}

// ────────── Largeur d'affichage ──────────
const ANSI = /\x1b\[[0-9;]*m/g;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const number = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function glyphWidth(glyph) {
  if (/^\p{Mark}+$/u.test(glyph)) return 0;
  if (/\p{Emoji_Presentation}|\p{Regional_Indicator}|[\ufe0f\u20e3]/u.test(glyph) ||
      /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(glyph)) return 2;
  return 1;
}

export function displayWidth(text) {
  return [...segmenter.segment(text.replace(ANSI, ''))].reduce((sum, item) => sum + glyphWidth(item.segment), 0);
}

export function clipAnsi(text, width, reset = '\x1b[0m') {
  if (displayWidth(text) <= width) return text;
  let output = '', used = 0;
  for (const token of text.match(/\x1b\[[0-9;]*m|[^\x1b]+/g) || []) {
    if (token.startsWith('\x1b[')) { output += token; continue; }
    for (const item of segmenter.segment(token)) {
      const size = glyphWidth(item.segment);
      if (used + size > Math.max(0, width - 1)) return output + '…' + reset;
      output += item.segment;
      used += size;
    }
  }
  return output + reset;
}

// ────────── Formats ──────────
export function modelName(modelId, displayName) {
  if (displayName) return displayName.replace(/\s*\((?:with )?1M context\)/i, '').trim();
  const match = modelId.match(/claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/i);
  if (!match) return modelId;
  return match[1][0].toUpperCase() + match[1].slice(1) + ' ' + match[2] + (match[3] ? '.' + match[3] : '');
}

function formatDuration(ms) {
  const seconds = Math.floor(number(ms) / 1000);
  if (seconds >= 3600) return Math.floor(seconds / 3600) + 'h' + String(Math.floor(seconds / 60) % 60).padStart(2, '0');
  if (seconds >= 60) return Math.floor(seconds / 60) + 'min';
  return seconds + 's';
}

function formatCountdown(seconds, day) {
  if (seconds >= 86400) return Math.floor(seconds / 86400) + day + Math.floor(seconds % 86400 / 3600) + 'h';
  if (seconds >= 3600) return Math.floor(seconds / 3600) + 'h' + String(Math.floor(seconds % 3600 / 60)).padStart(2, '0');
  return Math.max(1, Math.floor(seconds / 60)) + 'min';
}

const pctKey = (pct) => pct >= 80 ? 'crit' : pct >= 50 ? 'warn' : 'ok';

// Jauge en trait, pas de 5 % (demi-case « ╸ »).
export function bar(pct, p = painter('truecolor'), width = 10) {
  const halves = Math.round(Math.min(100, number(pct)) / 100 * width * 2);
  const full = halves >> 1, half = halves & 1;
  return p[pctKey(number(pct))] + '━'.repeat(full) + (half ? '╸' : '') + p.track + '━'.repeat(width - full - half) + p.reset;
}

function gauge(label, pct, resetsAt, nowSeconds, p, t) {
  const head = p.mute + label + ' ' + p.reset;
  if (!finite(pct)) return head + p.track + '━'.repeat(10) + p.dim + ' —' + p.reset;
  const reset = finite(resetsAt) && resetsAt > nowSeconds ? p.dim + ' ↻ ' + formatCountdown(resetsAt - nowSeconds, t.day) : '';
  return head + bar(pct, p) + ' ' + p[pctKey(pct)] + Math.round(number(pct)) + '%' + reset + p.reset;
}

// ────────── Étincelle ──────────
const breath = (frame, period) => (1 - Math.cos(2 * Math.PI * (frame % period) / period)) / 2;
const mix = ([low, high], k) => low.map((c, i) => Math.round(c + (high[i] - c) * k));

// Une seule étincelle, qui ne change jamais de forme : teinte et rythme disent l'état.
export function emote({ agents = 0, busy = false, idleMs = DONE_MS }, frame, p = painter('truecolor'), t = STRINGS.en) {
  const spark = (palette, period, label, labelColor) =>
    p.fg(mix(palette, breath(frame, period))) + EMOTE + ' ' + labelColor + label + p.reset;
  if (agents > 0) return spark(BREATH.clawd, 2, t.working, p.clawd);
  if (busy) return spark(BREATH.clawd, 4, t.working, p.clawd);
  if (idleMs < DONE_MS) return spark(BREATH.ok, 4, t.yourTurn, p.ok);
  if (idleMs < SLEEP_MS) return spark(BREATH.idle, 6, t.idle, p.mute);
  return spark(BREATH.sleep, 10, t.asleep, p.dim);
}

// Hooks UserPromptSubmit/Stop d'abord ; sans eux, un transcript écrit récemment vaut activité.
export function activity(act, transcriptMtime, now) {
  const mtime = number(transcriptMtime);
  if (act) {
    const last = act.busy ? Math.max(act.since, mtime) : act.since;
    if (act.busy && now - last < BUSY_TTL_MS) return { busy: true, idleMs: 0 };
    return { busy: false, idleMs: Math.max(0, now - last) };
  }
  if (mtime && now - mtime < 15_000) return { busy: true, idleMs: 0 };
  return { busy: false, idleMs: mtime ? Math.max(0, now - mtime) : DONE_MS };
}

function transcriptMtime(file) {
  if (typeof file !== 'string' || !file) return 0;
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// Réglages utilisateur puis projet (le plus spécifique l'emporte pour `language`) ; hooks cumulés.
export function readSettings(files) {
  let hooks = 0, language;
  for (const file of files) {
    let settings;
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (typeof settings?.language === 'string') language = settings.language;
    if (!settings?.hooks || typeof settings.hooks !== 'object') continue;
    for (const groups of Object.values(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) if (Array.isArray(group?.hooks)) hooks += group.hooks.length;
    }
  }
  return { hooks, language };
}

function settingsFiles(projectDir, env) {
  const files = new Map();
  for (const dir of [configDir(env), path.join(projectDir, '.claude')]) {
    for (const name of ['settings.json', 'settings.local.json']) {
      const file = path.resolve(dir, name);
      files.set(process.platform === 'win32' ? file.toLowerCase() : file, file);
    }
  }
  return [...files.values()];
}

function agentsText(agents, p, t) {
  const active = agents.filter((agent) => !agent.stale);
  const stale = agents.length - active.length;
  const n = active.length;
  let text = n ? t.agents(n) + p.mute + ' ' + active.slice(0, 3).map((agent) => agent.type).join(', ') +
    (n > 3 ? ', +' + (n - 3) : '') + p.reset : p.dim + t.agents(0) + p.reset;
  if (stale) text += p.warn + ' +' + stale + '?' + p.reset;
  return text;
}

// ────────── Rendu ──────────
export async function buildStatusline(input = {}, options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const frame = Math.floor(now / 1000);
  const cwd = typeof input.workspace?.current_dir === 'string' ? input.workspace.current_dir
    : typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const projectDir = typeof input.workspace?.project_dir === 'string' ? input.workspace.project_dir : cwd;
  const settings = options.settings ?? readSettings(settingsFiles(projectDir, env));
  const t = STRINGS[options.lang ?? detectLang({ env, settingsLanguage: settings.language })];
  const p = painter(options.colorMode ?? colorMode(env));
  const sep = p.dim + ' | ' + p.reset;
  const dot = p.dim + ' · ' + p.reset;

  const ctx = input.context_window || {};
  const modelId = safeText(input.model?.id, 60);
  const displayName = safeText(input.model?.display_name, 40);
  const style = MODEL_STYLES.find((s) => s.re.test(modelId || displayName)) || { icon: '▲', rgb: null };
  const size = number(ctx.context_window_size, /\[1m\]|-1m\b/i.test(modelId) ? 1_000_000 : 200_000);
  const effort = EFFORTS.indexOf(input.effort?.level);
  const line1 = (style.rgb ? p.fg(style.rgb) : '') + style.icon + ' ' + p.bold + (modelName(modelId, displayName) || '?') + p.reset +
    (size >= 1_000_000 ? p.mute + ' 1M' + p.reset : '') +
    (effort >= 0 ? dot + p.fg(EFFORT_RGB[effort]) + EFFORTS[effort] + ' ' + EFFORT_BARS.slice(0, effort + 1) +
      p.track + EFFORT_BARS.slice(effort + 1) + p.reset : '') +
    dot + p.mute + '⌂ ' + p.reset + (safeText(path.basename(cwd), 40) || '?') +
    dot + p.mute + '◷ ' + p.reset + (finite(input.cost?.total_duration_ms) ? formatDuration(input.cost.total_duration_ms) : '—');

  const usage = ctx.current_usage || {};
  const used = number(usage.input_tokens) + number(usage.cache_read_input_tokens) + number(usage.cache_creation_input_tokens);
  const ctxPct = finite(ctx.used_percentage) ? ctx.used_percentage : used > 0 && size > 0 ? used / size * 100 : null;
  const limits = input.rate_limits || {};
  const nowSeconds = now / 1000;
  const line2 = gauge('ctx', ctxPct, null, nowSeconds, p, t) + sep +
    gauge('5h', limits.five_hour?.used_percentage, limits.five_hour?.resets_at, nowSeconds, p, t) + sep +
    gauge(t.week, limits.seven_day?.used_percentage, limits.seven_day?.resets_at, nowSeconds, p, t);

  const agents = options.agents ?? readAgents(input.session_id, now);
  const state = options.activity ?? activity(readActivity(input.session_id), options.transcriptMtime ?? transcriptMtime(input.transcript_path), now);
  const gap = '   ';
  const line3 = emote({ ...state, agents: agents.filter((agent) => !agent.stale).length }, frame, p, t) +
    gap + agentsText(agents, p, t) + gap + p.dim + t.hooks(settings.hooks) + p.reset;

  const rawColumns = options.columns ?? env.COLUMNS ?? process.stdout.columns ?? 120;
  const columns = Number.isFinite(Number(rawColumns)) ? Math.max(8, Math.min(500, Math.floor(Number(rawColumns)))) : 120;
  return [line1, line2, line3].map((line) => clipAnsi(line, columns, p.reset)).join('\n');
}

// Chemins réels des deux côtés : ~/.claude ou le dossier temporaire peuvent être des liens symboliques (macOS : /var → /private/var).
const isMain = () => { try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };

if (isMain()) {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* entrée vide ou tronquée */ }
  buildStatusline(input).then((output) => process.stdout.write(output)).catch(() => {
    process.stdout.write('▲ ' + STRINGS[detectLang()].unavailable);
  });
}
