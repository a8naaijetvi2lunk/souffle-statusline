#!/usr/bin/env node
// Point d'entrée unique des hooks Claude Code (JSON sur stdin). N'écrit jamais sur stdout :
// pour UserPromptSubmit, toute sortie serait ajoutée au contexte de Claude.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordActivity, startAgent, stopAgent, clearSession, pruneOld, validId } from './state.mjs';

export function handleHook(input, now = Date.now()) {
  const sessionId = input?.session_id;
  if (!validId(sessionId)) return false;
  switch (input.hook_event_name) {
    case 'UserPromptSubmit': return recordActivity(sessionId, true, now);
    case 'Stop': return recordActivity(sessionId, false, now);
    case 'SubagentStart': return startAgent(sessionId, input.agent_id, input.agent_type, now);
    case 'SubagentStop': return stopAgent(sessionId, input.agent_id);
    case 'SessionEnd':
      clearSession(sessionId);
      pruneOld(now);
      return true;
    default: return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { handleHook(JSON.parse(fs.readFileSync(0, 'utf8') || '{}')); }
  catch { /* Un hook d'affichage ne bloque jamais la session. */ }
}
