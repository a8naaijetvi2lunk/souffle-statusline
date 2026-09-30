import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readActivity, readAgents, activityFile, stateDir, pruneOld, writeJson } from '../src/state.mjs';
import { sandbox, NOW } from './helpers.mjs';

const script = fileURLToPath(new URL('../src/hook.mjs', import.meta.url));
const hook = (payload) => spawnSync(process.execPath, [script], {
  input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', env: process.env, windowsHide: true,
});

test('UserPromptSubmit opens a turn, Stop closes it, nothing is printed', (t) => {
  sandbox(t);
  const start = hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hello' });
  assert.equal(start.status, 0);
  assert.equal(start.stdout + start.stderr, '');
  assert.equal(readActivity('s1').busy, true);
  assert.equal(hook({ hook_event_name: 'Stop', session_id: 's1' }).status, 0);
  assert.equal(readActivity('s1').busy, false);
});

test('subagents tracked by id; SessionEnd clears only that session', (t) => {
  sandbox(t);
  hook({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'Explore' });
  hook({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a2', agent_type: 'Explore' });
  hook({ hook_event_name: 'SubagentStart', session_id: 's2', agent_id: 'b1', agent_type: 'Plan' });
  hook({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a1' });
  assert.deepEqual(readAgents('s1').map((agent) => agent.type), ['Explore']);
  hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1' });
  hook({ hook_event_name: 'SessionEnd', session_id: 's1' });
  assert.deepEqual(readAgents('s1'), []);
  assert.equal(readActivity('s1'), null);
  assert.deepEqual(readAgents('s2').map((agent) => agent.type), ['Plan']);
});

test('garbage and hostile ids never write anything', (t) => {
  sandbox(t);
  for (const payload of ['{', '', { hook_event_name: 'Stop', session_id: '../../x' }, { hook_event_name: 'PreToolUse', session_id: 's1' },
    { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: '../x' }]) {
    const result = hook(payload);
    assert.equal(result.status, 0);
    assert.equal(result.stdout + result.stderr, '');
  }
  assert.equal(fs.existsSync(stateDir()), false);
});

test('agent type is sanitised; week-old state files are pruned', (t) => {
  sandbox(t);
  hook({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: '\x1b[31mEvil\nType' });
  assert.deepEqual(readAgents('s1').map((agent) => agent.type), ['Evil Type']);
  writeJson(activityFile('old-session'), { version: 1, busy: false, since: NOW });
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(activityFile('old-session'), old, old);
  assert.equal(pruneOld(), 1);
  assert.equal(fs.existsSync(activityFile('old-session')), false);
  assert.equal(fs.readdirSync(stateDir()).length, 1);
  assert.ok(path.basename(stateDir()) === 'state');
});
