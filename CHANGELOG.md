# Changelog

## 0.1.0 — 2026-09-30

First public release.

- Three-line status line: model, effort gauge, folder and session time; context, 5-hour and weekly quota gauges with reset countdowns; a breathing spark with the current activity, active subagents and configured hooks.
- Five spark states (working, working with subagents, your turn, idle, asleep), driven by `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop` and `SessionEnd` hooks, with the session transcript as a fallback.
- English and French, detected from Claude Code's `language` setting or the system locale.
- Truecolor with a 256-colour fallback, and `NO_COLOR` support.
- One-command install and uninstall that back up `settings.json`, keep your own hooks and restore your previous status line.
- `preview` command to try it without installing.
