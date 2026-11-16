import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/connection.js';
import { cycleStartDay, getSetting, today } from '../analytics/common.js';
import { POLICIES_DIR, REPORTS_DIR } from './routes/insurance.js';
import { APP_DIR, IN_DESKTOP, dataPath } from '../paths.js';
import { GEMINI_DEFAULT_MODEL, findKiro, geminiApiKey, geminiCommand, isModelId, kiroEnv, modelSettingKey } from './agentSetup.js';
import { dataCoverage } from '../analytics/balances.js';

/**
 * The data chat: each message runs one of the user's own AI command-line tools — Claude Code (`claude -p`),
 * Gemini CLI (`gemini`) or Kiro CLI (`kiro-cli chat`), chosen in Settings — with none of their built-in tools,
 * only the read-only `household` MCP server (src/agent/mcp.ts), and streams the answer back as server-sent events.
 *
 * - Claude also gets Read, limited by a hook to a copy of the insurance documents / reports (docs/), and the skills.
 * - Gemini and Kiro get the MCP tools only (no file access at all), so they can't open the documents themselves.
 *
 * A conversation continues with the provider's own resume: Claude / Gemini by their session id, Kiro by running in a
 * folder of its own per conversation (`--resume` continues the last conversation of that folder).
 */

export const AGENT_PROVIDERS = ['claude', 'gemini', 'kiro'] as const;
export type AgentProvider = typeof AGENT_PROVIDERS[number];

const PROVIDER_NAMES: Record<AgentProvider, string> = { claude: 'Claude Code (claude)', gemini: 'Gemini CLI (gemini)', kiro: 'Kiro CLI (kiro-cli)' };

export function agentProvider(db: DB): AgentProvider {
  const p = process.env.AGENT_PROVIDER ?? getSetting(db, 'agent_provider', 'claude');
  return (AGENT_PROVIDERS as readonly string[]).includes(p) ? p as AgentProvider : 'claude';
}

const AGENT_DIR = join(APP_DIR, 'agent');
// outside the repo, so the project's files, settings and CLAUDE.md aren't part of the agent's context
const WORKDIR = join(tmpdir(), 'household-agent');
const GEMINI_DIR = join(tmpdir(), 'household-agent-gemini');
const KIRO_DIR = join(tmpdir(), 'household-agent-kiro');

function schemaText(db: DB): string {
  const tables = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT IN ('sqlite_sequence', 'schema_version')
    AND sql IS NOT NULL ORDER BY name`).pluck().all() as string[];
  return tables.join(';\n');
}

const TOOLS_TEXT: Record<AgentProvider, string> = {
  claude: `Your only tools are the read-only household tools (api, sql), Skill, and Read for the documents in ./docs/: insurance policies
(./docs/policies, paths from api /insurance) and imported pension / insurance reports (./docs/reports, the file from api /pension).`,
  gemini: `Your only tools are the read-only household tools (api, sql) and activate_skill for the skills listed to you.
You can't open files: the insurance documents and imported reports aren't available in this setup. For a coverage question, answer
from the policy fields in api /insurance, say that the document itself wasn't read, and suggest the Claude option in Settings for it.`,
  kiro: `Your only tools are the read-only household tools (api, sql). The skills below are guides for recurring kinds of questions.
You can't open files: the insurance documents and imported reports aren't available in this setup. For a coverage question, answer
from the policy fields in api /insurance, say that the document itself wasn't read, and suggest the Claude option in Settings for it.`,
};

/** `--model <id>` when the user picked one in Settings; nothing = the tool's own default. All three CLIs take --model. */
function modelArgs(db: DB, provider: AgentProvider): string[] {
  const model = getSetting(db, modelSettingKey(provider), '').trim() || (provider === 'gemini' ? GEMINI_DEFAULT_MODEL : '');
  return model && isModelId(model) ? ['--model', model] : [];
}

function coverageText(db: DB): string {
  const rows = dataCoverage(db);
  if (!rows.length) return '- (no transactions yet)';
  return rows.map(c => `- ${c.name} [${c.accountId}, ${c.kind}]: ${c.firstDate} → ${c.lastDate} (${c.rows} rows)`).join('\n');
}

/** Only what changes: the standing instructions and the skills live in agent/ (CLAUDE.md, .claude/skills). */
function systemPrompt(db: DB, provider: AgentProvider = 'claude'): string {
  const members = (db.prepare(`SELECT id, name FROM members ORDER BY id`).all() as { id: number; name: string }[])
    .map(m => `${m.id}=${m.name}`).join(', ');
  const instructions = provider === 'claude' ? 'Follow the instructions in CLAUDE.md and use a skill when the question fits one.'
    : 'Follow the standing instructions below and use a skill when the question fits one.';
  return `You are the household data assistant of "הכספים של הבית". ${instructions}
${TOOLS_TEXT[provider]}

Today is ${today()}. A month ("cycle", key YYYY-MM) starts on day ${cycleStartDay(db)} of the month. Members: ${members}.

Data coverage (first → last day with rows, per account; before the first day there is no data from that account, not zero):
${coverageText(db)}

Database schema (bank.db):
${schemaText(db)}`;
}

/** Claude reads agent/CLAUDE.md by itself; the others get it in their prompt (without the Read-only parts that don't apply). */
function standingInstructions(): string {
  return readFileSync(join(AGENT_DIR, 'CLAUDE.md'), 'utf8')
    .replace(/^- `Read` — [\s\S]*?(?=\n\n|\n## )/m, '- Documents (insurance PDFs, reports) can\'t be opened in this setup — see above.');
}

const SKILLS_DIR = join(AGENT_DIR, '.claude', 'skills');
const skillNames = () => (existsSync(SKILLS_DIR) ? readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : []);

/**
 * Prepare the work dir (outside the repo, so the developer CLAUDE.md isn't loaded): agent/'s instructions
 * and skills, a copy of the policy files, and a settings file whose hook lets Read open only that copy.
 */
function syncAgentFiles(): void {
  rmSync(join(WORKDIR, '.claude'), { recursive: true, force: true });
  cpSync(AGENT_DIR, WORKDIR, { recursive: true, force: true });

  // docs/policies (insurance documents) and docs/reports (pension / insurance reports)
  const docs = join(WORKDIR, 'docs');
  rmSync(docs, { recursive: true, force: true });
  rmSync(join(WORKDIR, 'policies'), { recursive: true, force: true }); // the layout before docs/
  mkdirSync(docs);
  for (const [from, name] of [[POLICIES_DIR, 'policies'], [REPORTS_DIR, 'reports']] as const) {
    // symlinks are copied as links (not their targets), so the guard sees — and blocks — where they point
    if (existsSync(from)) cpSync(from, join(docs, name), { recursive: true, verbatimSymlinks: true });
    else mkdirSync(join(docs, name));
  }

  // in the desktop app process.execPath is Electron's binary: it runs the script as plain Node because claude (and so
  // its hooks) inherits ELECTRON_RUN_AS_NODE=1 from claudeEnv()
  const guard = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(APP_DIR, 'src', 'agent', 'guard-read.mjs'))} ${JSON.stringify(docs)}`;
  writeFileSync(join(WORKDIR, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: guard }] }] },
  }, null, 2));
}

/** The port this server actually listens on (the desktop app may pick a free one); set on each chat request. */
let apiPort = Number(process.env.PORT ?? 4310);

/** The read-only MCP server: from source with tsx, or (desktop app) the bundled build/desktop/mcp.mjs run by Electron's Node. */
function mcpCommand(): { command: string; args: string[] } {
  if (process.env.HOUSEHOLD_MCP_SCRIPT) return { command: process.execPath, args: [process.env.HOUSEHOLD_MCP_SCRIPT] };
  // tsx's own CLI script run by this Node: node_modules/.bin/tsx is a shell script that Windows can't spawn directly
  return { command: process.execPath, args: [join(APP_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(APP_DIR, 'src', 'agent', 'mcp.ts')] };
}

/** The read-only household MCP server, as every provider's config spells it. */
function householdServer() {
  return {
    ...mcpCommand(),
    env: {
      ...(IN_DESKTOP ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      BANK_DB: process.env.BANK_DB ? resolve(process.env.BANK_DB) : dataPath('bank.db'),
      HOUSEHOLD_API: `http://127.0.0.1:${apiPort}`,
    },
  };
}

function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // use the user's Claude subscription login, not an API key that may be set for other tools
  delete env.ANTHROPIC_API_KEY;
  // the API may itself be started from a Claude Code session
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // the desktop app: the Read hook runs Electron's binary as Node (claude itself is not Electron, it ignores this)
  if (IN_DESKTOP) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

/** API errors arrive as JSON nested in strings ("[API Error: {\"error\":{\"message\":\"{\\n \\\"error\\\"…") — keep the innermost message. */
function readableError(raw: string): string {
  const unescaped = raw.replace(/\\+"/g, '"').replace(/\\+n/g, ' ');
  const messages = [...unescaped.matchAll(/"message":\s*"([^"{}]+)"/g)].map(m => m[1].trim()).filter(Boolean);
  return (messages.at(-1) ?? raw).slice(0, 600);
}

// ---- one run: a child process whose stdout is turned into chat events ---------------------------

type Emit = (event: Record<string, unknown>) => void;
interface Run {
  child: ChildProcessWithoutNullStreams;
  /** one stdout line (JSON-lines providers) or a raw chunk (text providers) → events; return true once the answer ended */
  onOutput: (data: string, emit: Emit) => boolean;
  lineMode: boolean;
  /** what to report when the process exits before onOutput saw the end */
  onClose?: (code: number | null, stderr: string, emit: Emit) => void;
  /** a session id known before any output (Kiro: the conversation's folder) */
  sessionId?: string;
}

function startClaude(db: DB, message: string, sessionId: string | undefined): Run {
  mkdirSync(WORKDIR, { recursive: true });
  syncAgentFiles();
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    // of the built-in tools only Skill (the skills in agent/) and Read — which the hook limits to the
    // copied documents (docs/): no other files, no shell, no web
    '--tools', 'Skill,Read',
    // only the work dir's own settings (the Read guard) and skills, not the user's global ones
    '--setting-sources', 'project',
    '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { household: householdServer() } }),
    '--allowedTools', 'mcp__household__api,mcp__household__sql,Skill,Read(./docs/**)',
    '--system-prompt', systemPrompt(db, 'claude'),
    ...modelArgs(db, 'claude'),
    ...(sessionId ? ['--resume', sessionId] : []),
  ];
  const child = spawn(process.env.CLAUDE_PATH || 'claude', args, { cwd: WORKDIR, env: claudeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(message);
  return {
    child, lineMode: true,
    onOutput(line, emit) {
      let ev: Record<string, any>;
      try { ev = JSON.parse(line); } catch { return false; }
      if (ev.type === 'system' && ev.subtype === 'init') emit({ type: 'session', sessionId: ev.session_id });
      else if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
        emit({ type: 'text', text: ev.event.delta.text });
      } else if (ev.type === 'stream_event' && ev.event?.type === 'content_block_start' && ev.event.content_block?.type === 'text') {
        emit({ type: 'block' });
      } else if (ev.type === 'assistant') {
        for (const c of ev.message?.content ?? []) {
          if (c.type === 'tool_use') emit({ type: 'tool', name: String(c.name).replace(/^mcp__household__/, ''), input: c.input });
        }
      } else if (ev.type === 'result') {
        emit({ type: 'done', sessionId: ev.session_id, error: ev.is_error ? String(ev.result ?? ev.subtype) : null });
        return true;
      }
      return false;
    },
  };
}

/**
 * Gemini CLI headless (stream-json). The work dir's .gemini/settings.json allows no built-in tool except activate_skill
 * (`tools.core`), only the household MCP server (trusted: no confirmation, which headless can't ask for), and the skills;
 * GEMINI_SYSTEM_MD replaces Gemini's coding-agent system prompt with ours.
 */
/** Gemini CLI 0.68's built-in tools (its *_TOOL_NAME constants), all but activate_skill: no files, shell, web, agents. */
const GEMINI_BUILTIN_TOOLS = [
  'ask_user', 'complete_task', 'enter_plan_mode', 'exit_plan_mode', 'get_internal_docs', 'glob', 'google_web_search', 'grep_search',
  'invoke_agent', 'list_directory', 'list_mcp_resources', 'read_file', 'read_many_files', 'read_mcp_resource', 'replace',
  'run_shell_command', 'save_memory', 'search_file_content', 'take_snapshot', 'tracker_add_dependency', 'tracker_create_task',
  'tracker_get_task', 'tracker_list_tasks', 'tracker_update_task', 'tracker_visualize', 'update_topic', 'web_fetch', 'write_file', 'write_todos',
];

function startGemini(db: DB, message: string, sessionId: string | undefined): Run {
  rmSync(join(GEMINI_DIR, '.gemini'), { recursive: true, force: true });
  mkdirSync(join(GEMINI_DIR, '.gemini'), { recursive: true });
  cpSync(SKILLS_DIR, join(GEMINI_DIR, '.gemini', 'skills'), { recursive: true });
  if (!geminiApiKey()) throw new Error('חסר מפתח Gemini API. הדביקו אותו בהגדרות ← עוזר AI (מקבלים אותו בחינם ב-aistudio.google.com/apikey)');
  writeFileSync(join(GEMINI_DIR, '.gemini', 'settings.json'), JSON.stringify({
    // the API key the user saved in the app (Google ended the free "sign in with Google" for third-party clients)
    security: { auth: { selectedType: 'gemini-api-key' } },
    // every built-in tool off except activate_skill. (`tools.core: ['activate_skill']` also hides the MCP tools from the
    // model in CLI 0.68 — it then invents tool names and can't read the data.) The list is CLI 0.68's built-ins.
    tools: { exclude: GEMINI_BUILTIN_TOOLS },
    mcp: { allowed: ['household'] },
    mcpServers: { household: { ...householdServer(), trust: true, includeTools: ['api', 'sql'] } },
  }, null, 2));
  const systemFile = join(GEMINI_DIR, 'system.md');
  writeFileSync(systemFile, `${systemPrompt(db, 'gemini')}\n\n${standingInstructions()}`);

  const args = [
    '--output-format', 'stream-json', '--allowed-mcp-server-names', 'household', '--extensions', 'none', '--skip-trust',
    ...modelArgs(db, 'gemini'),
    ...(sessionId ? ['--resume', sessionId] : []),
  ];
  const gemini = geminiCommand();
  const apiKey = geminiApiKey();
  const child = spawn(gemini.command, [...gemini.args, ...args], {
    cwd: GEMINI_DIR, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: {
      ...process.env, ...gemini.env, GEMINI_SYSTEM_MD: systemFile, GEMINI_CLI_TRUST_WORKSPACE: 'true',
      ...(apiKey ? { GEMINI_API_KEY: apiKey } : {}),
    },
  });
  // no prompt argument: in headless mode the question is read from stdin
  child.stdin.end(message);
  let session: string | undefined, lastWasTool = false;
  const errors: string[] = [];
  return {
    child, lineMode: true,
    onOutput(line, emit) {
      let ev: Record<string, any>;
      try { ev = JSON.parse(line); } catch { return false; }
      if (ev.type === 'init' && ev.session_id) {
        session = `gemini-${ev.session_id}`;
        emit({ type: 'session', sessionId: session });
      } else if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
        if (lastWasTool) emit({ type: 'block' });
        lastWasTool = false;
        emit({ type: 'text', text: ev.content });
      } else if (ev.type === 'tool_use') {
        lastWasTool = true;
        const name = String(ev.tool_name ?? '').replace(/^(mcp_)?household_+/, '');
        emit({ type: 'tool', name: name === 'activate_skill' ? 'Skill' : name, input: name === 'activate_skill' ? { skill: ev.parameters?.name } : ev.parameters });
      } else if (ev.type === 'error' && ev.severity === 'error') {
        errors.push(String(ev.message ?? ''));
      } else if (ev.type === 'result') {
        const raw = ev.status === 'error' ? readableError(String(ev.error?.message || errors.join('\n') || 'error')) : null;
        emit({ type: 'done', sessionId: session,
          error: !raw ? null
            : /API key not valid|API_KEY_INVALID/i.test(raw) ? 'מפתח Gemini לא תקין. החליפו אותו בהגדרות ← עוזר AI'
            : /exhausted your daily quota|quota|RESOURCE_EXHAUSTED|429/i.test(raw)
              ? 'נגמרה המכסה היומית החינמית של המפתח למודל הזה. בחרו מודל אחר בהגדרות ← עוזר AI ← מודל (למשל Flash), או נסו שוב מחר'
            : /not found|is not supported|NOT_FOUND/i.test(raw) ? 'המודל שנבחר לא זמין למפתח הזה. בחרו מודל אחר בהגדרות ← עוזר AI ← מודל'
            : raw });
        return true;
      }
      return false;
    },
  };
}

/**
 * Kiro CLI headless (plain text). One folder per conversation, holding a `household` agent whose only tools are the
 * household MCP server's (`tools: ["@household"]`, no mcp.json / powers), the standing instructions as its prompt and
 * the skills as resources. `--resume` continues that folder's conversation.
 */
function startKiro(db: DB, message: string, sessionId: string | undefined): Run {
  const given = sessionId?.replace(/^kiro-/, '');
  // the id names a folder: only our own UUIDs
  const id = given && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(given) ? given : randomUUID();
  const dir = join(KIRO_DIR, id);
  const resume = id === given && existsSync(join(dir, '.kiro'));
  mkdirSync(join(dir, '.kiro', 'agents'), { recursive: true });
  rmSync(join(dir, 'skills'), { recursive: true, force: true });
  cpSync(SKILLS_DIR, join(dir, 'skills'), { recursive: true });
  writeFileSync(join(dir, '.kiro', 'agents', 'household.json'), JSON.stringify({
    name: 'household',
    description: 'Read-only assistant for the household finance data',
    prompt: `${systemPrompt(db, 'kiro')}\n\n${standingInstructions()}`,
    mcpServers: { household: householdServer() },
    tools: ['@household'],
    includeMcpJson: false,
    includePowers: false,
    permissions: { rules: [{ capability: 'mcp', match: ['household/*'], effect: 'allow' }] },
    resources: skillNames().map(s => `file://${join(dir, 'skills', s, 'SKILL.md')}`),
  }, null, 2));

  const args = ['chat', '--v3', '--no-interactive', '--agent', 'household', '--trust-tools=@household', '--require-mcp-startup',
    '--wrap', 'never', ...modelArgs(db, 'kiro'), ...(resume ? ['--resume'] : [])];
  const kiro = findKiro();
  if (!kiro) throw new Error('Kiro CLI לא מותקן. אפשר להתקין אותו מההגדרות ← עוזר AI');
  const child = spawn(kiro, args, { cwd: dir, env: kiroEnv(kiro), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdin.end(message);
  // eslint-disable-next-line no-control-regex
  const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
  return {
    child, lineMode: false, sessionId: `kiro-${id}`,
    onOutput(chunk, emit) {
      const text = chunk.replace(ansi, '').replace(/\r/g, '');
      if (text) emit({ type: 'text', text });
      return false;
    },
    onClose(code, stderr, emit) {
      const clean = stderr.replace(ansi, '').trim();
      // kiro-cli also logs [INFO] / warnings to stderr: show its error lines only
      const errorLines = clean.split('\n').filter(l => /^error\b|error:/i.test(l.trim()) && !/^\[(INFO|ERROR)\]/.test(l.trim()));
      const error = code === 0 ? null
        : /not logged in|kiro-cli login/i.test(clean) ? 'Kiro לא מחובר. התחברו בהגדרות ← עוזר AI ← ״התחבר ל-Kiro״'
        : (errorLines.join('\n') || clean.slice(-600)) || `kiro-cli exited with code ${code}`;
      emit({ type: 'done', sessionId: `kiro-${id}`, error });
    },
  };
}

const STARTERS: Record<AgentProvider, (db: DB, message: string, sessionId: string | undefined) => Run> = {
  claude: startClaude, gemini: startGemini, kiro: startKiro,
};

/** Which provider a session id belongs to (Claude's ids carry no prefix). */
const providerOfSession = (id: string): AgentProvider => (id.startsWith('gemini-') ? 'gemini' : id.startsWith('kiro-') ? 'kiro' : 'claude');

export function agentRoutes(app: FastifyInstance, db: DB): void {
  app.get('/api/agent', async () => ({ provider: agentProvider(db), providers: AGENT_PROVIDERS }));

  app.post('/api/agent/chat', async (req, reply) => {
    const address = app.server.address();
    if (typeof address === 'object' && address) apiPort = address.port;
    const { message, sessionId: requested } = (req.body ?? {}) as { message?: string; sessionId?: string };
    if (!message?.trim()) return reply.code(400).send({ error: 'message is required' });
    if (requested && !/^[\w-]{8,80}$/.test(requested)) return reply.code(400).send({ error: 'bad sessionId' });

    const provider = agentProvider(db);
    // a conversation started with another provider can't be continued here — start a new one
    const sessionId = requested && providerOfSession(requested) === provider
      ? (provider === 'gemini' ? requested.replace(/^gemini-/, '') : requested) : undefined;

    let run: Run;
    try {
      run = STARTERS[provider](db, message, sessionId);
    } catch (err) {
      return reply.code(500).send({ error: `could not prepare the ${PROVIDER_NAMES[provider]} chat: ${(err as Error).message}` });
    }
    const { child } = run;

    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const emit: Emit = event => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    if (run.sessionId) emit({ type: 'session', sessionId: run.sessionId });
    // the browser went away (closed the drawer, new chat) — stop the agent
    reply.raw.on('close', () => { if (child.exitCode == null) child.kill('SIGTERM'); });

    let buffer = '', stderr = '', finished = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (finished) return;
      if (!run.lineMode) { finished = run.onOutput(chunk.toString('utf8'), emit); return; }
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line && run.onOutput(line, emit)) { finished = true; break; }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', err => {
      if (finished) return;
      emit({ type: 'done', error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? `${PROVIDER_NAMES[provider]} is not installed or not on PATH — install it and sign in, then restart the app` : err.message });
      finished = true;
      reply.raw.end();
    });
    child.on('close', code => {
      if (!finished) {
        if (run.onClose) run.onClose(code, stderr, emit);
        else emit({ type: 'done', error: stderr.trim().slice(-600) || `${PROVIDER_NAMES[provider]} exited with code ${code}` });
        finished = true;
      }
      reply.raw.end();
    });
  });
}
