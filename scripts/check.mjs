#!/usr/bin/env node
/**
 * The verification gate before every commit (see .kiro/steering/git-sync.md): install what's missing, typecheck the
 * API, the desktop app and the web UI, run the tests. No build — building the installer is build-windows.cmd.
 *
 *   npm run check                  # install if needed → typecheck (API + desktop) → typecheck (web) → tests
 *   npm run check -- --clean       # fresh install (npm ci) first
 *   npm run check -- --skip-tests  # typecheck only
 *
 * Never touches the database, bank logins or data/.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const unknown = [...args].filter(a => !['--clean', '--skip-tests', '--help', '-h'].includes(a));
if (args.has('--help') || args.has('-h') || unknown.length) {
  if (unknown.length) console.error(`Unknown option: ${unknown.join(' ')}\n`);
  console.log('Usage: npm run check [-- --clean] [-- --skip-tests]');
  process.exit(unknown.length ? 1 : 0);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const steps = [];
const color = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);

function run(title, cmd, cmdArgs) {
  console.log(`\n${color('1;34', '▶')} ${color('1', title)}  ${color('2', [cmd, ...cmdArgs].join(' '))}`);
  const started = Date.now();
  const res = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  steps.push({ title, seconds: ((Date.now() - started) / 1000).toFixed(1), ok: res.status === 0 });
  if (res.status !== 0) {
    summary();
    console.error(color('1;31', `\n✗ ${title} failed${res.error ? `: ${res.error.message}` : ''} — fix it before committing.`));
    process.exit(res.status ?? 1);
  }
}

function summary() {
  console.log(`\n${color('1', 'Summary')}`);
  for (const s of steps) console.log(`  ${s.ok ? color('32', '✓') : color('31', '✗')} ${s.title.padEnd(28)} ${s.seconds}s`);
}

// Node version (package.json engines, e.g. ">=20")
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const required = Number(/(\d+)/.exec(pkg.engines?.node ?? '')?.[1] ?? 0);
if (Number(process.versions.node.split('.')[0]) < required) {
  console.error(color('1;31', `✗ Node.js ${pkg.engines.node} is required (this is ${process.versions.node}).`));
  process.exit(1);
}
console.log(`${color('1', 'FamilyCFO check')} · Node ${process.versions.node}`);

// Dependencies: a fresh install with --clean, otherwise only when missing or a lock file changed (postinstall installs web/ too)
const installedAt = dir => {
  const marker = join(ROOT, dir, 'node_modules', '.package-lock.json');
  return existsSync(marker) ? statSync(marker).mtimeMs : 0;
};
const lockAt = dir => statSync(join(ROOT, dir, 'package-lock.json')).mtimeMs;
if (args.has('--clean')) {
  rmSync(join(ROOT, 'web', 'node_modules'), { recursive: true, force: true });
  run('Install (clean)', npm, ['ci']);
} else if (installedAt('.') < lockAt('.') || installedAt('web') < lockAt('web')) {
  run('Install', npm, ['install']);
} else {
  console.log(`\n${color('2', '• Dependencies are up to date — skipping install (use --clean for a fresh one)')}`);
}

run('Typecheck (API + desktop)', npm, ['run', 'typecheck']);
run('Typecheck (web)', npm, ['--prefix', 'web', 'run', 'typecheck']);
if (!args.has('--skip-tests')) run('Tests', npm, ['test']);

summary();
console.log(color('1;32', '\n✓ All checks passed.'));
