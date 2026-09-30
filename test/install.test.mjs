import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { install, uninstall, paths, HOOK_EVENTS, RUNTIME_FILES } from '../src/install.mjs';
import { sandbox, sampleInput, strip } from './helpers.mjs';

const cli = fileURLToPath(new URL('../bin/souffle-statusline.mjs', import.meta.url));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const EXISTING = {
  model: 'opus',
  statusLine: { type: 'command', command: 'bash ~/my-old-statusline.sh' },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
  },
};

test('fresh install creates settings, hooks and runtime files', (t) => {
  sandbox(t);
  const result = install();
  const settings = readJson(result.settings);
  assert.equal(result.backup, null);
  assert.equal(settings.statusLine.refreshInterval, 1);
  assert.match(settings.statusLine.command, /^node ".+\/souffle\/statusline\.mjs"$/);
  assert.doesNotMatch(settings.statusLine.command, /\\/);
  for (const event of HOOK_EVENTS) {
    const [hook] = settings.hooks[event][0].hooks;
    assert.match(hook.command, /^node ".+\/souffle\/hook\.mjs"$/);
    assert.equal(hook.async, event === 'SessionEnd' ? undefined : true, event);
  }
  for (const file of RUNTIME_FILES) assert.ok(fs.existsSync(path.join(result.dir, file)), file);
});

test('install keeps everything else, is idempotent, uninstall restores the original exactly', (t) => {
  sandbox(t);
  const p = paths();
  fs.mkdirSync(p.config, { recursive: true });
  fs.writeFileSync(p.settings, JSON.stringify(EXISTING, null, 2));
  const first = install({ now: 1 });
  assert.ok(first.replaced);
  assert.deepEqual(readJson(first.backup), EXISTING);
  const once = fs.readFileSync(p.settings, 'utf8');
  install({ now: 2 });
  assert.equal(fs.readFileSync(p.settings, 'utf8'), once);
  const settings = readJson(p.settings);
  assert.equal(settings.model, 'opus');
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'notify-send done');
  assert.deepEqual(settings.hooks.PreToolUse, EXISTING.hooks.PreToolUse);
  const removed = uninstall({ now: 3 });
  assert.ok(removed.restored);
  assert.deepEqual(readJson(p.settings), EXISTING);
  assert.equal(fs.existsSync(p.dir), false);
});

test('uninstall without a previous status line removes the key and empty hook lists', (t) => {
  sandbox(t);
  const p = paths();
  install();
  uninstall();
  assert.deepEqual(readJson(p.settings), {});
});

test('invalid settings are never overwritten', (t) => {
  sandbox(t);
  const p = paths();
  fs.mkdirSync(p.config, { recursive: true });
  for (const content of ['{ "hooks": ', '[]', '{"hooks": []}']) {
    fs.writeFileSync(p.settings, content);
    assert.throws(() => install(), /nothing was changed/);
    assert.equal(fs.readFileSync(p.settings, 'utf8'), content);
    assert.equal(fs.existsSync(p.dir), false);
  }
});

test('installed command runs through a shell, even with spaces in the path', (t) => {
  const dir = sandbox(t);
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'my config');
  const settings = readJson(install().settings);
  const result = spawnSync(settings.statusLine.command, { shell: true, input: JSON.stringify(sampleInput(dir)),
    encoding: 'utf8', env: { ...process.env, COLUMNS: '120' }, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const lines = strip(result.stdout).split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^◆ Opus 4\.8 · xhigh/);
  const hook = spawnSync(settings.hooks.Stop[0].hooks[0].command, { shell: true,
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' }), encoding: 'utf8', windowsHide: true });
  assert.equal(hook.status, 0, hook.stderr);
  assert.ok(fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'souffle', 'state')));
});

test('CLI: install, help, unknown command', (t) => {
  sandbox(t);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: process.env, windowsHide: true });
  const installed = run();
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /installed in .+Restart Claude Code/s);
  assert.equal(run('help').status, 0);
  assert.match(run('--version').stdout, /^\d+\.\d+\.\d+/);
  assert.equal(run('nope').status, 1);
  const preview = run('preview', '--lang', 'fr');
  assert.equal(preview.status, 0);
  assert.match(strip(preview.stdout), /✻ en cours/);
});
