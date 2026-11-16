#!/usr/bin/env node
/**
 * Local build: install what's missing, check, test and build the web app — then `npm run serve`
 * runs everything (API + built UI) on http://127.0.0.1:4310.
 *
 *   npm run build                  # install if needed → typecheck → tests → web build
 *   npm run build -- --clean       # fresh install (npm ci) first
 *   npm run build -- --skip-tests  # skip the tests
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
  console.log('Usage: npm run build [-- --clean] [-- --skip-tests]');
  process.exit(unknown.length ? 1 : 0);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const steps = [];
const color = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);

function run(title, cmd, cmdArgs, env = {}) {
  console.log(`\n${color('1;34', '▶')} ${color('1', title)}  ${color('2', [cmd, ...cmdArgs].join(' '))}`);
  const started = Date.now();
  const res = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  steps.push({ title, seconds, ok: res.status === 0 });
  if (res.status !== 0) {
    summary();
    console.error(color('1;31', `\n✗ ${title} failed${res.error ? `: ${res.error.message}` : ''} — the build stopped here.`));
    process.exit(res.status ?? 1);
  }
}

function summary() {
  console.log(`\n${color('1', 'Summary')}`);
  for (const s of steps) console.log(`  ${s.ok ? color('32', '✓') : color('31', '✗')} ${s.title.padEnd(28)} ${s.seconds}s`);
}

// 1. Node version (package.json engines, e.g. ">=20")
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const required = Number(/(\d+)/.exec(pkg.engines?.node ?? '')?.[1] ?? 0);
const current = Number(process.versions.node.split('.')[0]);
if (current < required) {
  console.error(color('1;31', `✗ Node.js ${pkg.engines.node} is required (this is ${process.versions.node}).`));
  process.exit(1);
}
console.log(`${color('1', 'FamilyCFO local build')} · Node ${process.versions.node}`);

// 2. Dependencies: a fresh install with --clean, otherwise only when missing or the lock file changed
// (`postinstall` installs web/ too)
const installedAt = (dir) => {
  const marker = join(ROOT, dir, 'node_modules', '.package-lock.json');
  return existsSync(marker) ? statSync(marker).mtimeMs : 0;
};
const lockAt = (dir) => statSync(join(ROOT, dir, 'package-lock.json')).mtimeMs;
if (args.has('--clean')) {
  rmSync(join(ROOT, 'web', 'node_modules'), { recursive: true, force: true });
  run('Install (clean)', npm, ['ci']);
} else if (installedAt('.') < lockAt('.') || installedAt('web') < lockAt('web')) {
  run('Install', npm, ['install']);
} else {
  console.log(`\n${color('2', '• Dependencies are up to date — skipping install (use --clean for a fresh one)')}`);
}

// 3. Checks and build
run('Typecheck (API)', npm, ['run', 'typecheck']);
if (!args.has('--skip-tests')) run('Tests', npm, ['test']);
// tsc -p tsconfig.app.json && vite build → web/dist
run('Web app (typecheck + build)', npm, ['--prefix', 'web', 'run', 'build']);

summary();
console.log(color('1;32', '\n✓ Build complete.'));
console.log(`  Start it:  ${color('1', 'npm run serve')}  → http://127.0.0.1:${process.env.PORT ?? 4310}`);
console.log(`  Demo data: ${color('1', 'npm run demo && BANK_DB=demo.db npm run serve')}`);
