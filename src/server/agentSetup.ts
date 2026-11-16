import { spawn, type ChildProcess } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { delimiter, dirname, join } from 'path';
import type { FastifyInstance } from 'fastify';
import { APP_DIR, IN_DESKTOP, dataPath } from '../paths.js';

/**
 * Connecting the chat's AI tools from the app itself, without a terminal:
 * - Kiro CLI: found in its usual install folders (not only PATH); the account from `kiro-cli whoami`; sign-in with
 *   `kiro-cli login` (opens the browser, falls back to a device code); on Windows an install with the official script.
 * - Gemini CLI: shipped with the app (the @google/gemini-cli bundle, run by this Node / Electron's Node), signed in with
 *   a Gemini API key the user pastes once. The key is kept in a file in the data folder — not in the database, so
 *   neither the settings API nor the chat's read-only SQL can see it.
 */

const IS_WIN = process.platform === 'win32';

// ---- small process helper -------------------------------------------------------------------------------------------

function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    let out = '';
    let child: ChildProcess;
    try {
      child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: homedir() });
    } catch (err) {
      resolve({ code: null, out: String(err) });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', d => { out += d.toString(); });
    child.stderr?.on('data', d => { out += d.toString(); });
    child.on('error', err => { clearTimeout(timer); resolve({ code: null, out: String(err) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

// ---- Kiro CLI -------------------------------------------------------------------------------------------------------

function kiroCandidates(): string[] {
  const exe = IS_WIN ? 'kiro-cli.exe' : 'kiro-cli';
  const home = homedir();
  const known = IS_WIN
    ? [
      ...[process.env.ProgramW6432, process.env.ProgramFiles, 'C:\\Program Files'].filter(Boolean).map(p => join(p!, 'Kiro-Cli', exe)),
      join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Kiro-Cli', exe),
      join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Programs', 'Kiro-Cli', exe),
      join(home, '.local', 'bin', exe),
    ]
    : [join(home, '.local', 'bin', exe), '/opt/homebrew/bin/kiro-cli', '/usr/local/bin/kiro-cli', '/usr/bin/kiro-cli'];
  const onPath = (process.env.PATH || '').split(delimiter).filter(Boolean).map(d => join(d, exe));
  return [...known, ...onPath];
}

/** The kiro-cli binary, or null when it isn't installed. KIRO_PATH overrides. */
export function findKiro(): string | null {
  if (process.env.KIRO_PATH) return existsSync(process.env.KIRO_PATH) ? process.env.KIRO_PATH : null;
  for (const c of kiroCandidates()) {
    try { if (statSync(c).isFile()) return c; } catch { /* not here */ }
  }
  return null;
}

/** Environment for kiro-cli: its own folder first on PATH (it starts kiro-cli-chat from there). */
export function kiroEnv(kiro: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, NO_COLOR: '1' };
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
  env[key] = [dirname(kiro), env[key] ?? ''].join(delimiter);
  return env;
}

export interface KiroStatus { installed: boolean; loggedIn: boolean; account: string | null }
let kiroCache: { at: number; value: KiroStatus } | null = null;

async function kiroStatus(force = false): Promise<KiroStatus> {
  if (!force && kiroCache && Date.now() - kiroCache.at < 5000) return kiroCache.value;
  const kiro = findKiro();
  let value: KiroStatus = { installed: false, loggedIn: false, account: null };
  if (kiro) {
    const who = await run(kiro, ['whoami', '--format', 'json'], kiroEnv(kiro), 30_000);
    let account: string | null = null;
    try {
      const j = JSON.parse(stripAnsi(who.out).trim().split('\n').pop() || 'null') as Record<string, unknown> | null;
      if (j && typeof j === 'object') account = String(j.email ?? j.username ?? j.name ?? j.accountType ?? '') || null;
    } catch { /* plain text */ }
    value = { installed: true, loggedIn: who.code === 0, account: who.code === 0 ? account ?? 'מחובר' : null };
  }
  kiroCache = { at: Date.now(), value };
  return value;
}

export interface TaskState { state: 'idle' | 'running' | 'success' | 'error'; message?: string; url?: string; code?: string }

let kiroLogin: TaskState = { state: 'idle' };
let kiroLoginProc: ChildProcess | null = null;

function startKiroLogin(deviceFlow = false): TaskState {
  const kiro = findKiro();
  if (!kiro) return (kiroLogin = { state: 'error', message: 'Kiro CLI לא מותקן' });
  kiroLoginProc?.kill();
  kiroLogin = { state: 'running' };
  let out = '';
  const child = spawn(kiro, deviceFlow ? ['login', '--use-device-flow'] : ['login'], {
    env: kiroEnv(kiro), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: homedir(),
  });
  kiroLoginProc = child;
  const timer = setTimeout(() => child.kill(), 10 * 60_000);
  const onData = (d: Buffer) => {
    out = (out + stripAnsi(d.toString())).slice(-20_000);
    const url = out.match(/https?:\/\/[^\s"'<>]+/);
    const code = out.match(/Code:\s*([A-Z0-9]{3,}-[A-Z0-9]{3,})/i);
    if (url) kiroLogin.url = url[0];
    if (code) kiroLogin.code = code[1];
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', err => { kiroLogin = { state: 'error', message: err.message }; });
  child.on('close', code => {
    clearTimeout(timer);
    if (kiroLoginProc === child) kiroLoginProc = null;
    kiroCache = null;
    if (code === 0 || /already logged in/i.test(out)) kiroLogin = { state: 'success' };
    else if (!deviceFlow && /failed to open browser|use-device-flow/i.test(out)) startKiroLogin(true);
    else if (kiroLogin.state === 'running') {
      kiroLogin = { state: 'error', message: /network|connect|timed? ?out|ENOTFOUND|ECONN/i.test(out)
        ? 'אין חיבור לשרת ההתחברות של Kiro. בדקו את החיבור לאינטרנט ונסו שוב.'
        : 'ההתחברות לא הושלמה (הדפדפן נסגר או שתם הזמן). נסו שוב.' };
    }
  });
  return kiroLogin;
}

let kiroInstall: TaskState = { state: 'idle' };

/** Windows: the official installer (https://cli.kiro.dev/install.ps1) in an elevated PowerShell — one UAC prompt. */
function startKiroInstall(): TaskState {
  if (kiroInstall.state === 'running') return kiroInstall;
  if (!IS_WIN) return (kiroInstall = { state: 'error', message: 'התקנה אוטומטית זמינה רק בווינדוס. התקינו מ-kiro.dev/cli.' });
  kiroInstall = { state: 'running' };
  const dir = dataPath('setup');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'kiro-install.log');
  const script = join(dir, 'install-kiro.ps1');
  writeFileSync(script, '\uFEFF' + [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
    `& { irm 'https://cli.kiro.dev/install.ps1' | iex } *> '${log.replace(/'/g, "''")}'`,
    'exit $LASTEXITCODE',
  ].join('\r\n'));
  const inner = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
  const cmd = `$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '${inner.replace(/'/g, "''")}'; exit $p.ExitCode`;
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], process.env, 15 * 60_000).then(r => {
    kiroCache = null;
    kiroInstall = findKiro() ? { state: 'success' }
      : { state: 'error', message: r.code === 0 ? 'ההתקנה הסתיימה אבל Kiro CLI לא נמצא' : 'ההתקנה בוטלה או נכשלה (ייתכן שלא אושרה הרשאת מנהל)' };
  });
  return kiroInstall;
}

// ---- Gemini CLI -----------------------------------------------------------------------------------------------------

/** How to start Gemini CLI: the copy shipped with the app (run by this Node), else a `gemini` on PATH. */
export function geminiCommand(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const bundled = [
    process.env.HOUSEHOLD_GEMINI_SCRIPT,
    join(APP_DIR, 'gemini-cli', 'bundle', 'gemini.js'), // the desktop app's resources
    join(APP_DIR, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'), // from the repo
  ].find(p => p && existsSync(p));
  if (bundled) return { command: process.execPath, args: [bundled], env: IN_DESKTOP ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
  return { command: 'gemini', args: [], env: {} };
}

const GEMINI_KEY_FILE = () => dataPath('secrets', 'gemini-api-key');

/** The Gemini API key: GEMINI_API_KEY env, else the one saved in the app. */
export function geminiApiKey(): string | null {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try { return readFileSync(GEMINI_KEY_FILE(), 'utf8').trim() || null; } catch { return null; }
}

function saveGeminiKey(key: string | null): void {
  const file = GEMINI_KEY_FILE();
  if (!key) { rmSync(file, { force: true }); return; }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, key, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows: the user's own profile folder */ }
}

/** What people paste: the key with spaces / line breaks, in quotes, or as `GEMINI_API_KEY=…`. */
export function cleanGeminiKey(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^(export\s+)?(GEMINI_API_KEY|GOOGLE_API_KEY)\s*[=:]\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, '');
}

/** Ask Google whether the key works (lists the models; no tokens used). */
async function checkGeminiKey(key: string): Promise<'ok' | 'invalid' | 'offline' | string> {
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
      headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return 'ok';
    const body = await res.text();
    if (/API_KEY_INVALID|API key not valid|API key expired/i.test(body) || res.status === 401) return 'invalid';
    if (/SERVICE_DISABLED|has not been used|is disabled/i.test(body)) {
      return 'המפתח תקין, אבל ה-Gemini API לא מופעל בפרויקט שלו ב-Google. צרו מפתח ב-aistudio.google.com/apikey (שם הוא מופעל אוטומטית)';
    }
    if (/location is not supported|FAILED_PRECONDITION/i.test(body)) return 'Google לא מאפשרת את ה-Gemini API מהמיקום הזה';
    if (res.status === 403) return 'Google חסמה את המפתח (403). ייתכן שיש לו הגבלות (לפי אתר / אפליקציה / API) — צרו מפתח בלי הגבלות';
    return `Google החזירה שגיאה (${res.status}). נסו שוב בעוד רגע`;
  } catch {
    return 'offline'; // no internet right now: keep the key, the chat will report it if it's wrong
  }
}

// ---- routes ---------------------------------------------------------------------------------------------------------

export function agentSetupRoutes(app: FastifyInstance): void {
  app.get('/api/agent/setup', async req => {
    const force = (req.query as { refresh?: string }).refresh === '1';
    const gemini = geminiCommand();
    return {
      kiro: { ...(await kiroStatus(force)), login: kiroLogin, install: kiroInstall },
      gemini: { bundled: gemini.command !== 'gemini', hasKey: !!geminiApiKey(), keyFromEnv: !!process.env.GEMINI_API_KEY },
    };
  });

  app.post('/api/agent/kiro/login', async req => startKiroLogin((req.body as { deviceFlow?: boolean } | null)?.deviceFlow === true));
  app.post('/api/agent/kiro/install', async () => startKiroInstall());

  app.put('/api/agent/gemini/key', async (req, reply) => {
    const key = cleanGeminiKey(String((req.body as { key?: unknown } | null)?.key ?? ''));
    // Google's key formats change (AIza…, newer ones with dots): accept any key-like text and let Google decide
    if (!/^[\x21-\x7e]{20,400}$/.test(key)) {
      return reply.code(400).send({ error: 'זה לא נראה כמו מפתח: העתיקו את המפתח כולו מ-aistudio.google.com/apikey (כפתור ההעתקה ליד המפתח)' });
    }
    const check = await checkGeminiKey(key);
    if (check === 'invalid') return reply.code(400).send({ error: 'Google דחתה את המפתח. ודאו שהעתקתם אותו במלואו, או צרו מפתח חדש ב-aistudio.google.com/apikey' });
    if (check !== 'ok' && check !== 'offline') return reply.code(400).send({ error: check });
    saveGeminiKey(key);
    return { ok: true, verified: check === 'ok' };
  });
  app.delete('/api/agent/gemini/key', async () => { saveGeminiKey(null); return { ok: true }; });
}
