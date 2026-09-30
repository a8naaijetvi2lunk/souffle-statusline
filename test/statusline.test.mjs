import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildStatusline, displayWidth, clipAnsi, bar, emote, activity, readSettings, modelName, colorMode } from '../src/statusline.mjs';
import { STRINGS, detectLang } from '../src/i18n.mjs';
import { recordActivity, startAgent } from '../src/state.mjs';
import { strip, NOW, sandbox, sampleInput } from './helpers.mjs';

const base = { now: NOW, columns: 120, lang: 'en', colorMode: 'truecolor', settings: { hooks: 9 }, transcriptMtime: 0 };
const render = async (input, options = {}) => strip(await buildStatusline(input, { ...base, ...options })).split('\n');

test('three lines in English: model, gauges, spark', async (t) => {
  const dir = sandbox(t);
  assert.deepEqual(await render(sampleInput(dir)), [
    '◆ Opus 4.8 · xhigh ▁▂▃▄▅ · ⌂ my-app · ◷ 2min',
    'ctx ━━╸━━━━━━━ 25% | 5h ━━━━━━━━━━ 62% ↻ 1h48 | week ━━━━━━━━━━ 41% ↻ 3d5h',
    '✻ idle   0 agents   9 hooks',
  ]);
});

test('French labels', async (t) => {
  const dir = sandbox(t);
  const [, line2, line3] = await render(sampleInput(dir), { lang: 'fr' });
  assert.equal(line2, 'ctx ━━╸━━━━━━━ 25% | 5h ━━━━━━━━━━ 62% ↻ 1h48 | hebdo ━━━━━━━━━━ 41% ↻ 3j5h');
  assert.equal(line3, '✻ en pause   0 agent   9 hooks');
});

test('missing fields: no effort segment, empty quotas, 1M taken from the context size', async (t) => {
  const dir = sandbox(t);
  const input = sampleInput(dir);
  delete input.effort;
  delete input.rate_limits;
  input.model = { id: 'claude-opus-5-5[1m]', display_name: 'Opus 5.5 (1M context)' };
  input.context_window = { context_window_size: 1_000_000, used_percentage: null };
  const [line1, line2] = await render(input);
  assert.equal(line1, '◆ Opus 5.5 1M · ⌂ my-app · ◷ 2min');
  assert.equal(line2, 'ctx ━━━━━━━━━━ — | 5h ━━━━━━━━━━ — | week ━━━━━━━━━━ —');
  assert.equal(modelName('claude-haiku-4-5-20251001', ''), 'Haiku 4.5');
  assert.equal(modelName('claude-sonnet-5', ''), 'Sonnet 5');
});

test('spark: one glyph, colour breathes with a rhythm per state', () => {
  const states = [
    [{ busy: true }, 'working', 4], [{ agents: 2, busy: true }, 'working', 2],
    [{ idleMs: 10_000 }, 'your turn', 4], [{ idleMs: 5 * 60_000 }, 'idle', 6], [{ idleMs: 20 * 60_000 }, 'asleep', 10],
  ];
  const color = (text) => text.match(/^\x1b\[[0-9;]*m/)[0];
  for (const [state, label, period] of states) {
    const frames = Array.from({ length: 12 }, (_, i) => emote(state, i));
    for (const frame of frames) assert.equal(strip(frame), '✻ ' + label, JSON.stringify(state));
    assert.notEqual(color(frames[0]), color(frames[period / 2]), 'trough and peak differ: ' + label);
    assert.equal(color(frames[0]), color(frames[period]), 'one full period: ' + label);
  }
  assert.equal(strip(emote({ busy: true }, 0, undefined, STRINGS.fr)), '✻ en cours');
});

test('activity: hooks first, interrupted turn falls back to idle, transcript as a fallback', () => {
  assert.deepEqual(activity({ busy: true, since: NOW - 10_000 }, 0, NOW), { busy: true, idleMs: 0 });
  assert.deepEqual(activity({ busy: true, since: NOW - 300_000 }, NOW - 240_000, NOW), { busy: false, idleMs: 240_000 });
  assert.deepEqual(activity({ busy: true, since: NOW - 300_000 }, NOW - 30_000, NOW), { busy: true, idleMs: 0 });
  assert.deepEqual(activity({ busy: false, since: NOW - 30_000 }, NOW - 1_000, NOW), { busy: false, idleMs: 30_000 });
  assert.deepEqual(activity(null, NOW - 5_000, NOW), { busy: true, idleMs: 0 });
  assert.deepEqual(activity(null, 0, NOW), { busy: false, idleMs: 60_000 });
});

test('hook state drives line 3 end to end', async (t) => {
  const dir = sandbox(t);
  const input = sampleInput(dir);
  const line3 = async (now) => (await render(input, { now, activity: undefined, agents: undefined }))[2];
  recordActivity('test-session', true, NOW - 2_000);
  assert.equal(await line3(NOW), '✻ working   0 agents   9 hooks');
  startAgent('test-session', 'agent-1', 'Explore', NOW);
  startAgent('test-session', 'agent-2', 'Plan', NOW);
  startAgent('test-session', 'agent-old', 'Old', NOW - 3 * 60 * 60 * 1000);
  assert.match(await line3(NOW), /^✻ working {3}2 agents (Explore, Plan|Plan, Explore) \+1\? {3}9 hooks$/);
  fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'souffle', 'state'), { recursive: true });
  recordActivity('test-session', false, NOW - 2_000);
  assert.equal(await line3(NOW + 1_000), '✻ your turn   0 agents   9 hooks');
  assert.equal(await line3(NOW + 20 * 60_000), '✻ asleep   0 agents   9 hooks');
});

test('settings: hooks counted across files, language from the most specific file', async (t) => {
  const dir = sandbox(t);
  const config = process.env.CLAUDE_CONFIG_DIR;
  const project = path.join(dir, 'my-app', '.claude');
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ language: 'Français', hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'c' }] }, { hooks: 'invalid' }],
    Notification: 'invalid',
  } }));
  fs.writeFileSync(path.join(project, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'd' }] }] } }));
  fs.writeFileSync(path.join(project, 'settings.local.json'), '{ broken');
  const files = [path.join(config, 'settings.json'), path.join(project, 'settings.json'), path.join(project, 'settings.local.json')];
  assert.deepEqual(readSettings(files), { hooks: 4, language: 'Français' });
  const [, , line3] = await render(sampleInput(dir), { lang: undefined, settings: undefined });
  assert.equal(line3, '✻ en pause   0 agent   4 hooks');
});

test('language detection', () => {
  assert.equal(detectLang({ env: { SOUFFLE_LANG: 'fr' }, settingsLanguage: 'English' }), 'fr');
  assert.equal(detectLang({ env: {}, settingsLanguage: 'Français' }), 'fr');
  assert.equal(detectLang({ env: { LANG: 'fr_FR.UTF-8' }, settingsLanguage: 'English' }), 'en');
  assert.equal(detectLang({ env: { LANG: 'fr_FR.UTF-8' } }), 'fr');
  assert.equal(detectLang({ env: {} }), 'en');
});

test('colour modes: truecolor, 256 fallback, NO_COLOR', async (t) => {
  const dir = sandbox(t);
  assert.equal(colorMode({}), 'truecolor');
  assert.equal(colorMode({ TERM_PROGRAM: 'Apple_Terminal' }), '256');
  assert.equal(colorMode({ SOUFFLE_COLOR: '256' }), '256');
  assert.equal(colorMode({ NO_COLOR: '1', SOUFFLE_COLOR: 'truecolor' }), 'none');
  const rendered256 = await buildStatusline(sampleInput(dir), { ...base, colorMode: '256' });
  assert.match(rendered256, /\x1b\[38;5;\d+m/);
  assert.doesNotMatch(rendered256, /\x1b\[38;2;/);
  const plain = await buildStatusline(sampleInput(dir), { ...base, colorMode: 'none' });
  assert.doesNotMatch(plain, /\x1b/);
});

test('widths stay within 24, 40, 80 and 120 columns, hostile text is neutralised', async (t) => {
  const dir = sandbox(t);
  const input = sampleInput(dir);
  input.model.display_name = '\x1b[31mModel\n界👩‍💻' + 'long'.repeat(40);
  assert.equal(displayWidth('A界👩‍💻e' + String.fromCharCode(0x301)), 6);
  assert.equal(displayWidth('⚙✔✻*━╸'), 6);
  for (const columns of [24, 40, 80, 120]) {
    const rendered = await buildStatusline(input, { ...base, columns });
    assert.equal(rendered.split('\n').length, 3);
    for (const line of rendered.split('\n')) assert.ok(displayWidth(line) <= columns, `${columns}: ${strip(line)}`);
    assert.doesNotMatch(strip(rendered), /[\x00-\x09\x0b-\x1f]/);
  }
  assert.ok(displayWidth(clipAnsi('\x1b[31m界界界\x1b[0m', 4)) <= 4);
});

test('gauges clamp odd percentages', () => {
  assert.equal(strip(bar(150)), '━'.repeat(10));
  assert.equal(strip(bar(-5)), '━'.repeat(10));
  assert.equal(strip(bar(55)), '━━━━━╸━━━━');
});

test('real CLI: honours COLUMNS and survives empty input', (t) => {
  const dir = sandbox(t);
  const script = fileURLToPath(new URL('../src/statusline.mjs', import.meta.url));
  const run = (input, columns) => spawnSync(process.execPath, [script], { input, encoding: 'utf8',
    env: { ...process.env, COLUMNS: String(columns) }, windowsHide: true, cwd: dir });
  const result = run(JSON.stringify(sampleInput(dir)), 32);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.split('\n').length, 3);
  for (const line of result.stdout.split('\n')) assert.ok(displayWidth(line) <= 32);
  const empty = run('', 80);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout.split('\n').length, 3);
});
