// Aperçu sans installation : données d'exemple, rendu réel du script.
import { buildStatusline } from './statusline.mjs';

export const SAMPLE_AGENTS = [{ type: 'Explore', stale: false }, { type: 'Plan', stale: false }];

// Séquence d'un tour type : pause, travail, agents en renfort, puis « à toi ». Une image par seconde.
export const SCENES = [
  { frames: 6, activity: { busy: false, idleMs: 5 * 60_000 }, agents: [] },
  { frames: 8, activity: { busy: true, idleMs: 0 }, agents: [] },
  { frames: 6, activity: { busy: true, idleMs: 0 }, agents: SAMPLE_AGENTS },
  { frames: 8, activity: { busy: false, idleMs: 2_000 }, agents: [] },
];

export function sampleInput(nowSeconds, { elapsed = 0, ctx = 34 } = {}) {
  return {
    session_id: 'souffle-preview',
    workspace: { current_dir: '/home/you/my-app', project_dir: '/home/you/my-app' },
    model: { id: 'claude-opus-5-5[1m]', display_name: 'Opus 5.5 (1M context)' },
    effort: { level: 'xhigh' },
    cost: { total_duration_ms: (72 * 60 + elapsed) * 1000 },
    context_window: { context_window_size: 1_000_000, used_percentage: ctx },
    rate_limits: {
      five_hour: { used_percentage: 62, resets_at: nowSeconds + 108 * 60 },
      seven_day: { used_percentage: 41, resets_at: nowSeconds + (3 * 24 + 5) * 3600 },
    },
  };
}

// Toutes les images de la séquence, dans l'ordre (utilisé par l'aperçu animé et par les captures).
export async function sceneFrames({ lang = 'en', colorMode = 'truecolor', columns = 100, start = Date.UTC(2026, 0, 1) } = {}) {
  const out = [];
  let index = 0;
  for (const scene of SCENES) {
    for (let i = 0; i < scene.frames; i++, index++) {
      const now = start + index * 1000;
      const ctx = 34 + Math.floor(index / 4);
      out.push(await buildStatusline(sampleInput(now / 1000, { elapsed: index, ctx }), {
        now, lang, colorMode, columns, agents: scene.agents, activity: scene.activity, settings: { hooks: 9 },
      }));
    }
  }
  return out;
}

export async function preview({ lang = 'en', live = false, out = process.stdout } = {}) {
  const frames = await sceneFrames({ lang, columns: Math.min(out.columns || 100, 120) });
  if (!live || !out.isTTY) {
    for (const index of [0, 6, 14, 20]) out.write(frames[index] + '\n\n');
    return;
  }
  out.write('\x1b[?25l');
  const restore = () => out.write('\x1b[?25h\n');
  process.once('SIGINT', () => { restore(); process.exit(0); });
  for (let index = 0; ; index = (index + 1) % frames.length) {
    out.write((index ? '\x1b[2A\r' : '') + frames[index].split('\n').map((line) => line + '\x1b[K').join('\n'));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
