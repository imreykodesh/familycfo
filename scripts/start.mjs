#!/usr/bin/env node
/**
 * One step from nothing to the running app — what the double-click launchers (start-windows.cmd,
 * start-mac.command) run: build (scripts/build.mjs), start the server with the built UI, open the browser.
 * Closing the window (or Ctrl+C) stops the app.
 *
 *   npm run app                    # build → serve → open http://127.0.0.1:4310
 *   npm run app -- --skip-build    # start the last build
 *   npm run app -- --demo          # on demo.db (built first if missing)
 *   npm run app -- --no-open       # don't open the browser
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OPTIONS = ['--skip-build', '--demo', '--no-open', '--help', '-h'];
const args = new Set(process.argv.slice(2));
const unknown = [...args].filter(a => !OPTIONS.includes(a));
if (args.has('--help') || args.has('-h') || unknown.length) {
  if (unknown.length) console.error(`Unknown option: ${unknown.join(' ')}\n`);
  console.log('Usage: npm run app [-- --skip-build] [-- --demo] [-- --no-open]');
  process.exit(unknown.length ? 1 : 0);
}

const PORT = Number(process.env.PORT ?? 4310);
const APP_URL = `http://127.0.0.1:${PORT}`;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = { ...process.env, ...(args.has('--demo') ? { BANK_DB: 'demo.db' } : {}) };

function step(cmd, cmdArgs) {
  const res = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

async function isUp() {
  try {
    const res = await fetch(`${APP_URL}/api/meta`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function openBrowser() {
  if (args.has('--no-open')) return;
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', APP_URL]]
    : process.platform === 'darwin' ? ['open', [APP_URL]] : ['xdg-open', [APP_URL]];
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`Open ${APP_URL} in your browser.`));
    child.unref();
  } catch {
    console.log(`Open ${APP_URL} in your browser.`);
  }
}

// already running (another window): just open it
if (await isUp()) {
  console.log(`The app is already running on ${APP_URL}.`);
  openBrowser();
  process.exit(0);
}

if (!args.has('--skip-build')) step(process.execPath, [join(ROOT, 'scripts', 'build.mjs')]);
else if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) {
  console.error('There is no build yet — run without --skip-build.');
  process.exit(1);
}
if (args.has('--demo') && !existsSync(join(ROOT, 'demo.db'))) step(npm, ['run', 'demo']);

// the server: tsx's CLI run by this same Node, so Ctrl+C / closing the window stops it too
const tsx = join(ROOT, 'node_modules', 'tsx', JSON.parse(readFileSync(join(ROOT, 'node_modules', 'tsx', 'package.json'), 'utf8')).bin);
console.log(`\nStarting the app${args.has('--demo') ? ' (demo data)' : ''}…`);
const server = spawn(process.execPath, [tsx, join('src', 'server', 'index.ts'), '--serve-web'], { cwd: ROOT, stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
// stopped with Ctrl+C (signal, or 130 = 128 + SIGINT) is a normal stop, not an error
server.on('exit', (code, signal) => process.exit(signal || code === 130 ? 0 : code ?? 0));

for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 500));
  if (server.exitCode != null) break;
  if (await isUp()) {
    console.log(`\n✓ FamilyCFO is running on ${APP_URL} — close this window (or press Ctrl+C) to stop it.\n`);
    openBrowser();
    break;
  }
}
