// État local alimenté par les hooks : activité du tour et sous-agents actifs.
// Un fichier par session ou par agent, sous <config>/souffle/state. Aucun accès réseau.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const AGENT_TTL_MS = 2 * 60 * 60 * 1000;
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export const configDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const stateDir = (env = process.env) => env.SOUFFLE_STATE_DIR || path.join(configDir(env), 'souffle', 'state');

// Retire séquences ANSI/OSC et caractères de contrôle : rien d'injecté ne doit piloter le terminal.
export function safeText(value, max = 120) {
  if (typeof value !== 'string') return '';
  const clean = value.slice(0, 8192)
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')
    .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, max).join('');
}

export const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');

export const activityFile = (sessionId) => path.join(stateDir(), 'activity-' + hash(sessionId) + '.json');
export const agentPrefix = (sessionId) => 'agent-' + hash(sessionId) + '-';
export const agentFile = (sessionId, agentId) => path.join(stateDir(), agentPrefix(sessionId) + hash(agentId) + '.json');

export function readJson(file) {
  try {
    if (fs.statSync(file).size > 16 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

// Écriture atomique : fichier temporaire puis renommage.
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '-' + randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(data), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function recordActivity(sessionId, busy, now = Date.now()) {
  if (!validId(sessionId)) return false;
  writeJson(activityFile(sessionId), { version: 1, busy: Boolean(busy), since: now });
  return true;
}

export function readActivity(sessionId) {
  if (!validId(sessionId)) return null;
  const data = readJson(activityFile(sessionId));
  return data?.version === 1 && typeof data.busy === 'boolean' && Number.isFinite(data.since) ? data : null;
}

export function startAgent(sessionId, agentId, type, now = Date.now()) {
  if (!validId(sessionId) || !validId(agentId)) return false;
  writeJson(agentFile(sessionId, agentId), { version: 1, type: safeText(type, 48) || 'agent', startedAt: now });
  return true;
}

export function stopAgent(sessionId, agentId) {
  if (!validId(sessionId) || !validId(agentId)) return false;
  fs.rmSync(agentFile(sessionId, agentId), { force: true });
  return true;
}

export function readAgents(sessionId, now = Date.now()) {
  if (!validId(sessionId)) return [];
  const prefix = agentPrefix(sessionId);
  let names;
  try { names = fs.readdirSync(stateDir()); } catch { return []; }
  return names.filter((name) => name.startsWith(prefix) && /^[a-f0-9]{64}\.json$/.test(name.slice(prefix.length)))
    .map((name) => {
      const data = readJson(path.join(stateDir(), name));
      if (data?.version !== 1 || !Number.isFinite(data.startedAt)) return null;
      return { type: safeText(data.type, 48) || 'agent',
        stale: now - data.startedAt > AGENT_TTL_MS || data.startedAt > now + 60_000 };
    })
    .filter(Boolean);
}

// Fichiers exacts de la session seulement, jamais de suppression récursive.
export function clearSession(sessionId) {
  if (!validId(sessionId)) return false;
  fs.rmSync(activityFile(sessionId), { force: true });
  const prefix = agentPrefix(sessionId);
  let names;
  try { names = fs.readdirSync(stateDir()); } catch { return true; }
  for (const name of names) {
    if (name.startsWith(prefix) && /^[a-f0-9]{64}\.json$/.test(name.slice(prefix.length))) {
      fs.rmSync(path.join(stateDir(), name), { force: true });
    }
  }
  return true;
}

// Sessions jamais fermées proprement (plantage, terminal tué) : ménage au-delà de 7 jours.
export function pruneOld(now = Date.now()) {
  let names;
  try { names = fs.readdirSync(stateDir()); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!/^(activity|agent)-[a-f0-9-]+\.json$/.test(name)) continue;
    const file = path.join(stateDir(), name);
    try {
      if (now - fs.statSync(file).mtimeMs > PRUNE_AFTER_MS) { fs.rmSync(file, { force: true }); removed++; }
    } catch { /* déjà supprimé */ }
  }
  return removed;
}
