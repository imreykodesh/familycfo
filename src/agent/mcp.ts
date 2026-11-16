/**
 * MCP server (stdio) that gives the chat agent access to the household data — and nothing else.
 * Launched by `claude -p` from src/server/agent.ts; the agent has no other tools (no files, no shell).
 *
 *   api:    GET an endpoint of the household API — the same numbers the screens show
 *   sql:    a read-only SELECT on bank.db (opened read-only + query_only)
 *   change: POST / PUT / PATCH / DELETE a whitelisted endpoint of the API — the same calls the screens make,
 *           so every change goes through the app's own rules (manual edits marked as manual, aliases, re-matching).
 *           Never the scrape, the bank OTP, the chat itself or document uploads.
 */
import Database from 'better-sqlite3';
import { createInterface } from 'readline';

const DB_PATH = process.env.BANK_DB ?? 'bank.db';
const API = process.env.HOUSEHOLD_API ?? 'http://127.0.0.1:4310';
const MAX_ROWS = 300;
const MAX_CHARS = 60_000;

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');

// GET endpoints the agent may read (all are read-only)
const API_PATHS = /^\/(summary|income|cashflow|forecast|coverage|cards\/upcoming|month-plan|installments|recurring|budgets|planning|alerts|recommendations|networth|transactions|transactions\/\d+\/similar|planned|rules|links|categories|meta|events(\/\d+(\/candidates)?)?|businesses\/\d+\/report|members|accounts|businesses|tags|funds|assets|asset-snapshots|liabilities|liability-snapshots|scheduled|sync-status|scrape\/runs|logs|insurance|pension|investments)$/;

// endpoints the agent may change (the method is checked by the API's own routes)
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const WRITE_PATHS = new RegExp('^/(' + [
  'budgets', 'settings', 'fx', 'pipeline', 'recommendations/state', 'alerts/\\d+',
  'categories(/\\d+)?',
  'transactions/(\\d+|bulk|manual|\\d+/manual)', 'rules(/\\d+)?', 'links(/\\d+)?',
  'planned(/\\d+(/match)?)?',
  'events/\\d+/transactions',
  'insurance(/\\d+)?', 'insurance/documents/\\d+',
  'investments/refresh', 'investments/holdings(/\\d+)?',
  '(members|businesses|tags|funds|assets|asset-snapshots|liabilities|liability-snapshots|scheduled)(/\\d+)?',
  'accounts/[\\w:.@-]+',
].join('|') + ')$');

const TOOLS = [
  {
    name: 'api',
    description: `GET an endpoint of the household API (JSON). Prefer it: the numbers match the app's screens.
Paths: /summary, /month-plan?cycle=YYYY-MM, /cashflow?cycles=N (per-month income/spend/byCategory), /budgets?cycle=, /income?cycle=,
/transactions?cycle=YYYY-MM|from=&to=&category=ID&search=TEXT&kind=expense,income&account=ID&limit=N, /installments, /cards/upcoming,
/forecast, /recurring, /planned, /networth, /recommendations, /alerts, /categories, /meta (members, accounts, categories, tags),
/insurance (policies, their documents with a path to open with Read, actual payments, insurance charges with no policy),
/pension (pension / study / provident funds: value, fees, tracks + returns, deposits, expected pension; the latest report's totals),
/investments (stock-market holdings: live price, value in ILS, gain vs buy price / baseline, today's change, value history).
/sync-status (each bank's last scrape: result, failures in a row, explanation), /scrape/runs?company=&failed=1&limit=N (scrape history with
the error, the bank page's text when it failed, and an explanation), /logs?level=error|warn&days=N&search=TEXT (the app's log lines).
Common filters on most: member=ID, business=ID, tags=ID,ID.`,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'e.g. /cashflow?cycles=6' } },
      required: ['path'],
    },
  },
  {
    name: 'sql',
    description: `Run one read-only SQLite SELECT (or WITH … SELECT) on bank.db. Max ${MAX_ROWS} rows. Use for questions the API doesn't answer.`,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'change',
    description: `Change household data through the app's API — the same calls its screens make. Returns the API's JSON answer.
Use only for a change the user asked for or confirmed (see CLAUDE.md "Changing data" for the endpoints and their bodies).
Examples: PUT /budgets {"categoryId":12,"monthlyAmount":1500}; PATCH /transactions/123 {"categoryId":7};
POST /transactions/bulk {"ids":[1,2],"patch":{"categoryId":7}}; POST /rules {"fromTransactionId":123,"setCategoryId":7};
POST /transactions/manual {"date":"2026-11-02","description":"מזומן — שוק","amount":120,"categoryId":7};
POST /planned {"description":"מקרר","amount":4500,"date":"2026-12-01","accountId":"max:1234","installments":3};
POST /categories {"name":"חוגים","parentId":3}.`,
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: [...WRITE_METHODS] },
        path: { type: 'string', description: 'e.g. /budgets or /transactions/123' },
        body: { type: 'object', description: 'JSON body (omit for DELETE)' },
      },
      required: ['method', 'path'],
    },
  },
];

const clip = (s: string) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n…[truncated — narrow the request]` : s);

async function callApi(path: string): Promise<string> {
  const [pathname, search = ''] = path.trim().replace(/^\/api/, '').split('?');
  if (!API_PATHS.test(pathname)) throw new Error(`path not allowed: ${pathname}`);
  const res = await fetch(`${API}/api${pathname}${search ? `?${search}` : ''}`);
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
  return clip(body);
}

async function callChange(method: string, path: string, body: unknown): Promise<string> {
  const m = method.trim().toUpperCase();
  if (!WRITE_METHODS.has(m)) throw new Error(`method not allowed: ${method}`);
  const [pathname, search = ''] = path.trim().replace(/^\/api/, '').split('?');
  if (!WRITE_PATHS.test(pathname)) throw new Error(`path not allowed for changes: ${pathname}`);
  const hasBody = m !== 'DELETE' || (body != null && typeof body === 'object' && Object.keys(body).length > 0);
  const res = await fetch(`${API}/api${pathname}${search ? `?${search}` : ''}`, {
    method: m,
    headers: hasBody ? { 'content-type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  return clip(text || '{"ok":true}');
}

function runSql(query: string): string {
  const q = query.trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(q) || /\b(attach|detach|pragma|vacuum|load_extension)\b/i.test(q)) {
    throw new Error('only a single SELECT / WITH query is allowed');
  }
  const stmt = db.prepare(q);
  if (!stmt.reader) throw new Error('only queries that return rows are allowed');
  const rows: unknown[] = [];
  for (const row of stmt.iterate()) {
    rows.push(row);
    if (rows.length >= MAX_ROWS) break;
  }
  return clip(JSON.stringify({ rows, truncated: rows.length >= MAX_ROWS }));
}

type Msg = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, any> };
const send = (msg: object): void => { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`); };

async function handle(msg: Msg): Promise<void> {
  if (msg.id == null) return; // notifications (initialized, cancelled)
  switch (msg.method) {
    case 'initialize':
      return send({ id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'household', version: '1.0.0' },
      } });
    case 'ping':
      return send({ id: msg.id, result: {} });
    case 'tools/list':
      return send({ id: msg.id, result: { tools: TOOLS } });
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params ?? {};
      try {
        const text = name === 'api' ? await callApi(String(args.path ?? ''))
          : name === 'sql' ? runSql(String(args.query ?? ''))
          : name === 'change' ? await callChange(String(args.method ?? ''), String(args.path ?? ''), args.body)
          : (() => { throw new Error(`unknown tool ${name}`); })();
        return send({ id: msg.id, result: { content: [{ type: 'text', text }] } });
      } catch (err) {
        return send({ id: msg.id, result: { content: [{ type: 'text', text: String(err instanceof Error ? err.message : err) }], isError: true } });
      }
    }
    default:
      return send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let msg: Msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch(err => process.stderr.write(`${err}\n`));
});
