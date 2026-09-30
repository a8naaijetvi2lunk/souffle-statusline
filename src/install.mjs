// Installation : copie le runtime dans <config>/souffle puis fusionne settings.json.
// Idempotent, sauvegarde horodatée avant écriture, JSON invalide = aucune modification.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir } from './state.mjs';

export const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd'];
export const RUNTIME_FILES = ['statusline.mjs', 'hook.mjs', 'state.mjs', 'i18n.mjs'];
const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function paths(env = process.env) {
  const config = path.resolve(configDir(env));
  const dir = path.join(config, 'souffle');
  return { config, dir, settings: path.join(config, 'settings.json'), previous: path.join(dir, 'previous-statusline.json') };
}

// Barres obliques et guillemets : Git Bash avale les « \ » des commandes, et les chemins peuvent contenir des espaces.
const slashes = (file) => file.split(path.sep).join('/');
export const command = (file) => `node "${slashes(file)}"`;
export const isOurs = (cmd, dir) => typeof cmd === 'string' && cmd.includes(slashes(dir) + '/');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Retire nos hooks ; supprime les groupes et événements devenus vides, laisse le reste intact.
export function stripHooks(hooks, dir) {
  if (!isObject(hooks)) return hooks;
  const out = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) { out[event] = groups; continue; }
    const kept = groups
      .map((group) => Array.isArray(group?.hooks) ? { ...group, hooks: group.hooks.filter((hook) => !isOurs(hook?.command, dir)) } : group)
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (kept.length) out[event] = kept;
  }
  return out;
}

export function mergeSettings(settings, dir) {
  const next = structuredClone(settings);
  next.statusLine = { type: 'command', command: command(path.join(dir, 'statusline.mjs')), refreshInterval: 1 };
  next.hooks = stripHooks(next.hooks, dir) ?? {};
  if (!isObject(next.hooks)) throw new Error('settings.json: "hooks" must be an object; nothing was changed.');
  for (const event of HOOK_EVENTS) {
    const hook = { type: 'command', command: command(path.join(dir, 'hook.mjs')), timeout: 5 };
    // SessionEnd reste synchrone : un hook asynchrone risque d'être coupé à la fermeture.
    if (event !== 'SessionEnd') hook.async = true;
    if (!Array.isArray(next.hooks[event])) next.hooks[event] = [];
    next.hooks[event].push({ hooks: [hook] });
  }
  return next;
}

export function unmergeSettings(settings, dir, previousStatusLine) {
  const next = structuredClone(settings);
  if (isOurs(next.statusLine?.command, dir)) {
    if (isObject(previousStatusLine)) next.statusLine = previousStatusLine;
    else delete next.statusLine;
  }
  if (next.hooks !== undefined) {
    const hooks = stripHooks(next.hooks, dir);
    if (isObject(hooks) && !Object.keys(hooks).length) delete next.hooks;
    else next.hooks = hooks;
  }
  return next;
}

function readSettings(file) {
  if (!fs.existsSync(file)) return { raw: null, settings: {} };
  const raw = fs.readFileSync(file, 'utf8');
  let settings;
  try { settings = raw.trim() ? JSON.parse(raw) : {}; }
  catch { throw new Error(`${file} is not valid JSON; nothing was changed.`); }
  if (!isObject(settings)) throw new Error(`${file} must contain a JSON object; nothing was changed.`);
  return { raw, settings };
}

function writeSettings(file, raw, settings, now) {
  let backup = null;
  if (raw !== null) {
    backup = file + '.souffle-backup-' + new Date(now).toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(backup, raw);
  }
  const temporary = file + '.souffle-tmp';
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(temporary, file);
  return backup;
}

export function install({ env = process.env, source = SOURCE_DIR, now = Date.now() } = {}) {
  const p = paths(env);
  const { raw, settings } = readSettings(p.settings);
  const next = mergeSettings(settings, p.dir);
  fs.mkdirSync(p.dir, { recursive: true });
  for (const file of RUNTIME_FILES) fs.copyFileSync(path.join(source, file), path.join(p.dir, file));
  // Mémorise la statusline existante (pas la nôtre) pour la rendre à la désinstallation.
  if (isObject(settings.statusLine) && !isOurs(settings.statusLine.command, p.dir)) {
    fs.writeFileSync(p.previous, JSON.stringify(settings.statusLine, null, 2) + '\n');
  } else if (!settings.statusLine) {
    fs.rmSync(p.previous, { force: true });
  }
  const backup = writeSettings(p.settings, raw, next, now);
  return { ...p, backup, replaced: isObject(settings.statusLine) && !isOurs(settings.statusLine.command, p.dir) };
}

export function uninstall({ env = process.env, now = Date.now() } = {}) {
  const p = paths(env);
  const { raw, settings } = readSettings(p.settings);
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(p.previous, 'utf8')); } catch { /* aucune statusline à restaurer */ }
  const backup = raw === null ? null : writeSettings(p.settings, raw, unmergeSettings(settings, p.dir, previous), now);
  // Garde-fou : on ne supprime que notre propre dossier, jamais le dossier de configuration.
  if (path.basename(p.dir) === 'souffle' && path.dirname(p.dir) === path.resolve(p.config)) {
    fs.rmSync(p.dir, { recursive: true, force: true });
  }
  return { ...p, backup, restored: isObject(previous) };
}
