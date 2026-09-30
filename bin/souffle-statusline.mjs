#!/usr/bin/env node
// CLI : install (par défaut), uninstall, preview.
import fs from 'node:fs';
import { install, uninstall } from '../src/install.mjs';
import { preview } from '../src/preview.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [command = 'install', ...args] = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const HELP = `Souffle — statusline ${pkg.version}
A breathing status line for Claude Code.

Usage: souffle-statusline [command] [options]

Commands:
  install              Install or update (default). Backs up settings.json first.
  uninstall            Remove Souffle and restore your previous status line.
  preview [--live]     Show sample output without installing (--live animates it).
                       --lang en|fr picks the language.
  help, --version

Respects CLAUDE_CONFIG_DIR. Restart Claude Code after installing: hooks load at startup.`;

try {
  if (command === 'install') {
    const result = install();
    console.log(`✻ Souffle ${pkg.version} installed in ${result.dir}`);
    if (result.backup) console.log(`  settings.json backed up to ${result.backup}`);
    if (result.replaced) console.log('  Your previous status line was saved; "uninstall" puts it back.');
    console.log('  Restart Claude Code to load the hooks.');
  } else if (command === 'uninstall') {
    const result = uninstall();
    console.log(`Souffle removed from ${result.config}` + (result.restored ? ' (previous status line restored).' : '.'));
    if (result.backup) console.log(`  settings.json backed up to ${result.backup}`);
  } else if (command === 'preview') {
    await preview({ lang: value('--lang') === 'fr' ? 'fr' : 'en', live: flag('--live') });
  } else if (command === '--version' || command === '-v') {
    console.log(pkg.version);
  } else if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
  } else {
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error('✗ ' + error.message);
  process.exitCode = 1;
}
