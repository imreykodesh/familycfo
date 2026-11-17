/**
 * MCP server (stdio) that gives the chat agent access to the household data — and nothing else.
 * Launched by `claude -p` from src/server/agent.ts; the agent has no other tools (no files, no shell).
 *
 *   api:    GET an endpoint of the household API — the same numbers the screens show
 *   sql:    a read-only SELECT on bank.db (opened read-only + query_only)
 *   change: POST / PUT / PATCH / DELETE a whitelisted endpoint of the API — the same calls the screens make,
 *           so every change goes through the app's own rules (manual edits marked as manual, aliases, re-matching).
 *           Never the scrape, the bank OTP, the chat itself or document uploads (pension/import takes the JSON the
 *           agent extracted from a report the user uploaded).
 *   read_document: (Gemini / Kiro — Claude has its own Read, limited by a hook) open an insurance document or an
 *           uploaded report from data/policies or data/reports, and nothing else. Gemini gets the file itself (it reads
 *           PDFs and images natively, scans too); Kiro gets the PDF's text layer, since it can't take files from an MCP tool.
 */
import Database from 'better-sqlite3';
import { readFileSync, realpathSync, statSync } from 'fs';
import { extname, join, sep } from 'path';
import { createInterface } from 'readline';

const DB_PATH = process.env.BANK_DB ?? 'bank.db';
const API = process.env.HOUSEHOLD_API ?? 'http://127.0.0.1:4310';
const MAX_ROWS = 300;
const MAX_CHARS = 60_000;

/** gemini | kiro: offer read_document (unset for Claude, which uses Read) */
const DOC_MODE = process.env.HOUSEHOLD_DOC_MODE;
const DOC_DIRS: Record<string, string | undefined> = { policies: process.env.HOUSEHOLD_POLICIES_DIR, reports: process.env.HOUSEHOLD_REPORTS_DIR };
/** Gemini takes inline files up to ~20 MB per request */
const MAX_INLINE = 15 * 1024 * 1024;
const DOC_MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
};

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('query_only = ON');

// GET endpoints the agent may read (all are read-only)
const API_PATHS = /^\/(summary|income|cashflow|forecast|coverage|cards\/upcoming|month-plan|installments|recurring|budgets|planning|alerts|recommendations|networth|transactions|transactions\/\d+\/similar|planned|rules|links|categories|meta|events(\/\d+(\/candidates)?)?|businesses\/\d+\/report|members|accounts|businesses|tags|funds|assets|asset-snapshots|liabilities|liability-snapshots|scheduled|sync-status|scrape\/runs|logs|insurance|pension|investments|balance-history|history-range|allowance|seasonal|month-close|month-report|simulator\/(base|debts))$/;

// endpoints the agent may change (the method is checked by the API's own routes)
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const WRITE_PATHS = new RegExp('^/(' + [
  'budgets', 'settings', 'fx', 'pipeline', 'recommendations/state', 'alerts/\\d+',
  'categories(/\\d+)?',
  'transactions/(\\d+|bulk|manual|\\d+/manual)', 'rules(/\\d+)?', 'links(/\\d+)?',
  'planned(/\\d+(/match)?)?',
  'events/\\d+/transactions',
  'seasonal(/\\d+(/settle)?|/pot)?',
  'month-close/\\d{4}-\\d{2}(/checks)?',
  'insurance(/\\d+)?', 'insurance/documents/\\d+', 'pension/import',
  'investments/refresh', 'investments/holdings(/\\d+)?',
  '(members|businesses|tags|funds|assets|asset-snapshots|liabilities|liability-snapshots|scheduled)(/\\d+)?',
  'accounts/[\\w:.@-]+',
].join('|') + ')$');
const AGENT_SETTINGS = ['cycle_start_day', 'balance_buffer', 'scrape_months_back'];

const TOOLS: { name: string; description: string; inputSchema: object }[] = [
  {
    name: 'api',
    description: `GET an endpoint of the household API (JSON). Prefer it: the numbers match the app's screens.
Paths: /summary, /month-plan?cycle=YYYY-MM, /cashflow?cycles=N (per-month income/spend/byCategory, oldest first; N up to 36 —
ask for as many as the question needs, e.g. 24), /budgets?cycle=, /income?cycle=,
/coverage (per account: the first and last date the database has rows for — before that there is NO DATA, which is not zero),
/balance-history?account=ID&from=&to=&daily=1 (each bank account's balance per month: start, end, min + date, days below zero;
negativeSince = when the current overdraft started; rebuilt from the rows back from the current balance, for the whole history),
/transactions?cycle=YYYY-MM|from=&to=&category=ID&search=TEXT&kind=expense,income&account=ID&limit=N, /installments, /cards/upcoming,
/forecast, /recurring, /planned, /networth, /recommendations, /alerts, /categories, /meta (members, accounts, categories, tags),
/insurance (policies, their documents with a path to open with Read, actual payments, insurance charges with no policy),
/pension (pension / study / provident funds: value, fees, tracks + returns, deposits, expected pension; the latest report's totals),
/investments (stock-market holdings: live price, value in ILS, gain vs buy price / baseline, today's change, value history).
/allowance (how much can be spent per day until the end of the planning period without dropping below the buffer: perDay, bindingDate,
the usual pace, known income / payments left, the expected-events set-aside), /seasonal (the expected-events fund: holidays by the
Hebrew calendar and other yearly events, next dates, the pot, how much to put aside per month, events waiting for "how much did it take").
/month-close?cycle=YYYY-MM (closing a month: checks — accounts with rows to the end, duplicates, uncategorized, fixed items that didn't
show up, waiting links / planned; closed or not), /month-report?cycle=YYYY-MM (the month vs the average, top categories, over budget,
ended fixed items, debts, top recommendations). Default: the last month that ended.
/simulator/base (average monthly spend per category over the complete months, savings goals, loans that can be simulated and why
others can't), /simulator/debts?extra=₪&cpi=%&fee=% (repaying the loans: only the fixed repayments vs snowball — smallest balance first —
vs avalanche — highest interest first — with extra ₪ a month more: months to repay, interest, CPI linkage, fees, saving, closing order).
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

const READ_DOCUMENT = {
  name: 'read_document',
  description: `Open an insurance document or an uploaded / imported report — the only files you can open.
path: as given by the API (/insurance policies[].documents[].path, /pension report.documentPath) or by the user's message,
e.g. "docs/reports/pension-2026.pdf" or "docs/policies/3/12-policy.pdf".
pages (PDF, optional): e.g. "1-5" or "2,7-9" — for a long document read the first pages (contents / summary), then what you need.`,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, pages: { type: 'string', description: 'e.g. 1-5' } },
    required: ['path'],
  },
};
if (DOC_MODE) TOOLS.push(READ_DOCUMENT);

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
  // settings: only the household ones — not the AI provider / models, the categorization URL (it would receive
  // transaction descriptions), the schedule or notifications
  if (pathname === '/settings') {
    const keys = Object.keys((body ?? {}) as object);
    const other = keys.filter(k => !AGENT_SETTINGS.includes(k));
    if (!keys.length || other.length) throw new Error(`only these settings can be changed here: ${AGENT_SETTINGS.join(', ')}`);
  }
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

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } };

/** The file behind docs/policies/… or docs/reports/…, only if it really is inside that folder (symlinks resolved). */
function documentFile(path: string): string {
  const parts = path.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/^docs\//, '').split('/').filter(Boolean);
  const base = DOC_DIRS[parts[0] ?? ''];
  if (!base || parts.length < 2 || parts.includes('..')) throw new Error('only files in docs/policies/ and docs/reports/ can be opened');
  let root: string, file: string;
  try { root = realpathSync(base); } catch { throw new Error('there are no documents yet'); }
  try { file = realpathSync(join(root, ...parts.slice(1))); } catch { throw new Error(`${path} does not exist`); }
  if (!file.startsWith(root + sep) || !statSync(file).isFile()) throw new Error('only files in docs/policies/ and docs/reports/ can be opened');
  return file;
}

/** "2,4-6" → [2, 4, 5, 6] within 1..total; nothing → all pages. */
function pageList(spec: string | undefined, total: number): number[] {
  if (!spec?.trim()) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map(n => Number(n.trim()));
    if (!Number.isInteger(a)) continue;
    for (let p = a; p <= (Number.isInteger(b) ? b : a); p++) if (p >= 1 && p <= total) pages.add(p);
  }
  return [...pages].sort((x, y) => x - y);
}

/** The PDF's text layer, page by page (empty for a scan). */
async function pdfText(data: Buffer, spec: string | undefined): Promise<{ total: number; pages: { page: number; text: string }[] }> {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const pages = [];
  for (const page of pageList(spec, pdf.numPages)) {
    const content = await (await pdf.getPage(page)).getTextContent();
    // table cells are separate items: keep them apart
    const text = content.items.map(item => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '')).join('')
      .replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
    pages.push({ page, text });
  }
  return { total: pdf.numPages, pages };
}

const CANT_SEE = `This setup (Kiro) can only read text: tell the user in Hebrew that this file is a photo or a scan, which Kiro can't read,
and that it works if they pick Claude or Gemini in Settings → עוזר AI, or upload the original PDF the bank / agent / insurer sent (not a scan).`;

async function readDocument(path: string, pages: string | undefined): Promise<Content[]> {
  const file = documentFile(path);
  const mime = DOC_MIME[extname(file).toLowerCase()];
  if (!mime) throw new Error('unsupported file type');
  const data = readFileSync(file);
  if (mime.startsWith('text/') || mime === 'application/json') return [{ type: 'text', text: clip(data.toString('utf8')) }];

  // Gemini reads the file itself (layout, tables, scans) — unless it is too big to send, then the text layer
  if (DOC_MODE === 'gemini' && data.length <= MAX_INLINE) {
    const head = { type: 'text' as const, text: `${path} (${mime}, ${Math.round(data.length / 1024)} KB) follows.` };
    return mime === 'application/pdf'
      ? [head, { type: 'resource', resource: { uri: `file:///${encodeURIComponent(path)}`, mimeType: mime, blob: data.toString('base64') } }]
      : [head, { type: 'image', data: data.toString('base64'), mimeType: mime }];
  }
  if (mime !== 'application/pdf') {
    return [{ type: 'text', text: DOC_MODE === 'gemini' ? 'The image is too large to open (over 15 MB).' : CANT_SEE }];
  }
  const { total, pages: list } = await pdfText(data, pages);
  if (!list.length) throw new Error(`no such pages — the document has ${total}`);
  const body = list.map(p => `--- page ${p.page} of ${total} ---\n${p.text || '(no text on this page)'}`).join('\n\n');
  const scanned = list.every(p => p.text.length < 20);
  return [{ type: 'text', text: scanned && DOC_MODE !== 'gemini' ? `${body}\n\n${CANT_SEE}` : clip(`${path}: ${total} pages, text layer.\n\n${body}`) }];
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
        if (name === 'read_document' && DOC_MODE) {
          return send({ id: msg.id, result: { content: await readDocument(String(args.path ?? ''), args.pages ? String(args.pages) : undefined) } });
        }
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
