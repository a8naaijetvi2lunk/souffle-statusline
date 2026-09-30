// Libellés affichés : anglais par défaut, français sur demande ou par détection.
export const STRINGS = {
  en: {
    working: 'working',
    yourTurn: 'your turn',
    idle: 'idle',
    asleep: 'asleep',
    agents: (n) => n + (n === 1 ? ' agent' : ' agents'),
    hooks: (n) => n + (n === 1 ? ' hook' : ' hooks'),
    week: 'week',
    day: 'd',
    unavailable: 'status line unavailable',
  },
  fr: {
    working: 'en cours',
    yourTurn: 'à toi',
    idle: 'en pause',
    asleep: 'en veille',
    agents: (n) => n + (n > 1 ? ' agents' : ' agent'),
    hooks: (n) => n + (n > 1 ? ' hooks' : ' hook'),
    week: 'hebdo',
    day: 'j',
    unavailable: 'statusline indisponible',
  },
};

// Priorité : SOUFFLE_LANG, puis la clé `language` des réglages Claude Code, puis la locale système.
export function detectLang({ env = process.env, settingsLanguage } = {}) {
  const explicit = String(env.SOUFFLE_LANG || '').toLowerCase();
  if (Object.hasOwn(STRINGS, explicit)) return explicit;
  if (typeof settingsLanguage === 'string' && settingsLanguage.trim()) {
    return /^(fr|fran|french)/i.test(settingsLanguage.trim()) ? 'fr' : 'en';
  }
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return /^fr/i.test(locale) ? 'fr' : 'en';
}
