import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
export const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);

// Configuration Claude isolée dans un dossier temporaire ; l'environnement est restauré après le test.
export function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souffle test '));
  const saved = { ...process.env };
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'config');
  for (const key of ['SOUFFLE_STATE_DIR', 'SOUFFLE_LANG', 'SOUFFLE_COLOR', 'NO_COLOR']) delete process.env[key];
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

export function sampleInput(dir, now = NOW) {
  return {
    session_id: 'test-session',
    workspace: { current_dir: path.join(dir, 'my-app'), project_dir: path.join(dir, 'my-app') },
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    effort: { level: 'xhigh' },
    cost: { total_duration_ms: 120_000 },
    context_window: { context_window_size: 200_000, used_percentage: 25 },
    rate_limits: {
      five_hour: { used_percentage: 62, resets_at: now / 1000 + 108 * 60 },
      seven_day: { used_percentage: 41, resets_at: now / 1000 + (3 * 24 + 5) * 3600 },
    },
  };
}
