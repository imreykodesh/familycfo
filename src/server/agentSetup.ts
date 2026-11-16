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
    if (code === 0 || /already logged in/i.test(out)) { kiroLogin = { state: 'success' }; modelCache.delete('kiro'); }
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
  for (const k of modelCache.keys()) if (k.startsWith('gemini:')) modelCache.delete(k);
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

/** What the chat / the settings say when the key's Google project has no prepaid credit left (HTTP 402). */
export const GEMINI_NO_CREDIT = 'המפתח תקין, אבל בפרויקט שלו ב-Google נגמר הקרדיט ששולם מראש, ולכן Google לא עונה. הוסיפו קרדיט ב-ai.studio/projects, או צרו מפתח בפרויקט אחר (בלי חיוב מראש) והחליפו אותו בהגדרות ← עוזר AI';
export const isGeminiNoCredit = (text: string) => /prepayment credits|credits are depleted|"code":\s*402/i.test(text);

/**
 * Ask Google whether the key works: the model list (free), then a one-word question to the default model — the list
 * answers even when the project can't pay for answers (prepaid credit used up).
 */
async function checkGeminiKey(key: string): Promise<'ok' | 'invalid' | 'offline' | string> {
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
      headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const ask = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_DEFAULT_MODEL}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } }),
      }).catch(() => null);
      if (ask && ask.status === 402) return GEMINI_NO_CREDIT;
      if (ask && !ask.ok && isGeminiNoCredit(await ask.text())) return GEMINI_NO_CREDIT;
      // other answers (a used-up daily quota, a busy model) don't make the key wrong: the chat explains them
      return 'ok';
    }
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

// ---- models -------------------------------------------------------------------------------------------------------

export interface AgentModel {
  id: string;
  name: string;
  description?: string;
  /** context window, tokens */
  contextTokens?: number;
  /** Kiro: credits per request relative to the base rate (e.g. 2 = twice) */
  rate?: number;
}
export interface ModelList { models: AgentModel[]; defaultModel: string | null; error?: string; source?: string }

const MODEL_CACHE_MS = 10 * 60_000;
const modelCache = new Map<string, { at: number; value: ModelList }>();
const cached = async (key: string, force: boolean, load: () => Promise<ModelList>): Promise<ModelList> => {
  const hit = modelCache.get(key);
  if (!force && hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.value;
  const value = await load();
  if (!value.error) modelCache.set(key, { at: Date.now(), value });
  return value;
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Kiro: `kiro-cli chat --list-models --format json` — the account's models right now, with credits and context (no credits used). */
async function kiroModelsFromCli(kiro: string): Promise<ModelList | null> {
  const r = await run(kiro, ['chat', '--list-models', '--format', 'json'], kiroEnv(kiro), 60_000);
  const line = stripAnsi(r.out).split('\n').map(l => l.trim()).reverse().find(l => l.startsWith('{'));
  if (r.code !== 0 || !line) return null;
  try {
    const j = JSON.parse(line) as { models?: Record<string, unknown>[]; default_model?: string };
    const models = (j.models ?? []).map(m => ({
      id: String(m.model_id ?? m.modelId ?? m.id ?? ''),
      name: String(m.model_name ?? m.name ?? m.model_id ?? m.id ?? ''),
      description: typeof m.description === 'string' ? m.description : undefined,
      contextTokens: num(m.context_window_tokens),
      rate: num(m.rate_multiplier),
    })).filter(m => m.id);
    return models.length ? { models, defaultModel: j.default_model ? String(j.default_model) : null, source: 'cli' } : null;
  } catch { return null; }
}

/** Kiro fallback: the models a new ACP session offers (`kiro-cli acp` → initialize → session/new). */
function kiroModelsFromAcp(kiro: string): Promise<ModelList | null> {
  return new Promise(resolve => {
    const child = spawn(kiro, ['acp'], { env: kiroEnv(kiro), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: homedir() });
    let buf = '', done = false;
    const finish = (v: ModelList | null) => { if (done) return; done = true; clearTimeout(timer); child.kill(); resolve(v); };
    const timer = setTimeout(() => finish(null), 60_000);
    const send = (id: number, method: string, params: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdout.on('data', d => {
      buf += d.toString();
      let n: number;
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n).trim();
        buf = buf.slice(n + 1);
        let m: { id?: number; result?: Record<string, any>; error?: unknown };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) return finish(null);
          send(2, 'session/new', { cwd: homedir(), mcpServers: [] });
        } else if (m.id === 2) {
          const models = m.result?.models;
          if (m.error || !Array.isArray(models?.availableModels)) return finish(null);
          finish({
            models: models.availableModels.map((x: Record<string, unknown>) => ({
              id: String(x.modelId ?? x.id), name: String(x.name ?? x.modelId ?? x.id),
              description: typeof x.description === 'string' ? x.description : undefined,
            })),
            defaultModel: models.currentModelId ?? null,
            source: 'acp',
          });
        }
      }
    });
    send(1, 'initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'familycfo', version: '1' } });
  });
}

async function kiroModels(force: boolean): Promise<ModelList> {
  const kiro = findKiro();
  if (!kiro) return { models: [], defaultModel: null, error: 'Kiro CLI לא מותקן' };
  // signed out, these commands start a sign-in of their own (and wait for it): check first
  if (!(await kiroStatus(force)).loggedIn) return { models: [], defaultModel: null, error: 'Kiro לא מחובר — התחברו כדי לראות את המודלים' };
  return cached('kiro', force, async () => (await kiroModelsFromCli(kiro)) ?? (await kiroModelsFromAcp(kiro))
    ?? { models: [], defaultModel: null, error: 'Kiro לא החזיר רשימת מודלים. נסו שוב בעוד רגע' });
}

/** Gemini: the models the key may use (Google's model list; no tokens used), only those that can chat. */
async function geminiModels(force: boolean): Promise<ModelList> {
  const key = geminiApiKey();
  if (!key) return { models: [], defaultModel: null, error: 'הזינו מפתח Gemini כדי לראות את המודלים' };
  return cached(`gemini:${key.slice(-6)}`, force, async () => {
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
        headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { models: [], defaultModel: null, error: `Google לא החזירה את רשימת המודלים (${res.status})` };
      const j = await res.json() as { models?: { name: string; displayName?: string; description?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }[] };
      const models = (j.models ?? [])
        .filter(m => m.name.startsWith('models/gemini') && m.supportedGenerationMethods?.includes('generateContent'))
        // speech / image / live / embedding variants can't answer a text chat with tools
        .filter(m => !/(tts|image|live|audio|embedding|native-audio|robotics|computer-use|transcribe|banana)/i.test(m.name))
        .map(m => ({ id: m.name.replace(/^models\//, ''), name: m.displayName ?? m.name, description: m.description, contextTokens: m.inputTokenLimit }))
        .sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));
      return { models, defaultModel: GEMINI_DEFAULT_MODEL, source: 'api' };
    } catch {
      return { models: [], defaultModel: null, error: 'אין חיבור ל-Google כרגע' };
    }
  });
}

/**
 * The model the chat uses when none was picked. Not the CLI's own default (gemini-2.5-pro): a free API key usually has
 * no quota for Pro, so the chat would fail out of the box. The \-latest\ alias follows Google's current Flash.
 */
export const GEMINI_DEFAULT_MODEL = 'gemini-flash-latest';

/** Claude Code has no list command; these are the names it accepts for the newest model of each family. */
function claudeModels(): ModelList {
  return {
    models: [
      { id: 'opus', name: 'Opus', description: 'החזק ביותר, איטי ויקר יותר במכסת המנוי' },
      { id: 'sonnet', name: 'Sonnet', description: 'מאוזן — מהיר ומדויק' },
      { id: 'haiku', name: 'Haiku', description: 'המהיר והחסכוני ביותר' },
    ],
    defaultModel: null,
    source: 'aliases',
  };
}

export async function listModels(provider: 'claude' | 'gemini' | 'kiro', force = false): Promise<ModelList> {
  return provider === 'kiro' ? kiroModels(force) : provider === 'gemini' ? geminiModels(force) : claudeModels();
}

/** Setting key of the model chosen for a provider (empty / missing = the tool's own default). */
export const modelSettingKey = (provider: string) => `agent_model_${provider}`;
export const MODEL_SETTING_KEYS = ['agent_model_claude', 'agent_model_gemini', 'agent_model_kiro'];
export const isModelId = (v: string) => /^[\w.:/@-]{0,120}$/.test(v);

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

  app.get('/api/agent/models', async (req, reply) => {
    const q = req.query as { provider?: string; refresh?: string };
    if (q.provider !== 'claude' && q.provider !== 'gemini' && q.provider !== 'kiro') return reply.code(400).send({ error: 'provider must be claude, gemini or kiro' });
    return listModels(q.provider, q.refresh === '1');
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
