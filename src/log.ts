import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { format } from 'util';

/**
 * Log files: everything the app prints (console.* and the API's own log) is also appended to
 * `data/logs/<name>-YYYY-MM-DD.log` (git-ignored; LOG_DIR overrides), one line per entry with time and level,
 * so a failed scrape can be looked at later — in the app's "יומן ותקלות" page or in the file.
 * Files older than LOG_KEEP_DAYS (default 14) are deleted. They are local only, like the database.
 */

export const LOG_DIR = resolve(process.env.LOG_DIR ?? join('data', 'logs'));
const KEEP_DAYS = Math.max(1, Number(process.env.LOG_KEEP_DAYS ?? 14) || 14);
const MAX_READ_BYTES = 2_000_000;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const localDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(d);
const localTime = (d = new Date()) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(d);

let installed: string | null = null;
let failed = false;

function fileFor(name: string, day = localDay()): string {
  return join(LOG_DIR, `${name}-${day}.log`);
}

function write(name: string, level: LogLevel, text: string): void {
  if (failed) return;
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    const stamp = `${localDay()} ${localTime()}`;
    const body = text.replace(/\r/g, '').split('\n').map((l, i) => (i ? `    ${l}` : l)).join('\n');
    appendFileSync(fileFor(name), `${stamp} ${level.toUpperCase().padEnd(5)} ${body}\n`);
  } catch {
    failed = true; // a read-only disk shouldn't break the app; the console still gets everything
  }
}

function prune(): void {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
    for (const f of readdirSync(LOG_DIR)) {
      if (f.endsWith('.log') && statSync(join(LOG_DIR, f)).mtimeMs < cutoff) unlinkSync(join(LOG_DIR, f));
    }
  } catch { /* no log dir yet */ }
}

/** Mirror console.* into today's `<name>` log file. Idempotent. */
export function installFileLog(name: 'server' | 'scrape'): void {
  if (installed) return;
  installed = name;
  prune();
  const levels: [keyof Console & ('log' | 'info' | 'warn' | 'error' | 'debug'), LogLevel][] = [
    ['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error'], ['debug', 'debug'],
  ];
  for (const [method, level] of levels) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(...args);
      write(name, level, format(...args));
    };
  }
}

const PINO_LEVELS: Record<number, LogLevel> = { 10: 'debug', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'error' };

/** A stream for Fastify's (pino) logger: still prints to stdout, and writes a readable line to the server log. */
export const serverLogStream = {
  write(msg: string): void {
    process.stdout.write(msg);
    try {
      const e = JSON.parse(msg) as { level: number; msg?: string; err?: { message?: string; stack?: string }; req?: { method?: string; url?: string } };
      const where = e.req ? ` ${e.req.method} ${e.req.url}` : '';
      write('server', PINO_LEVELS[e.level] ?? 'info', `${e.msg ?? ''}${where}${e.err?.stack ? `\n${e.err.stack}` : ''}`);
    } catch {
      write('server', 'info', msg.trim());
    }
  },
};

export interface LogLine { time: string; level: LogLevel; source: string; text: string }

/** The newest log lines of every source (server + scrape) for the last `days` days, oldest first. */
export function readLogs(opts: { days?: number; limit?: number; level?: LogLevel; search?: string } = {}): { lines: LogLine[]; files: string[] } {
  const days = Math.min(Math.max(opts.days ?? 2, 1), KEEP_DAYS);
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
  const rank: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const min = opts.level ? rank[opts.level] : 0;
  const search = opts.search?.trim().toLowerCase();
  if (!existsSync(LOG_DIR)) return { lines: [], files: [] };

  const wanted = new Set(Array.from({ length: days }, (_, i) => localDay(new Date(Date.now() - i * 86_400_000))));
  const files = readdirSync(LOG_DIR).filter(f => /^(server|scrape)-\d{4}-\d{2}-\d{2}\.log$/.test(f) && wanted.has(f.slice(-14, -4))).sort();
  const lines: LogLine[] = [];
  for (const f of files) {
    let text = readFileSync(join(LOG_DIR, f), 'utf8');
    if (text.length > MAX_READ_BYTES) text = text.slice(-MAX_READ_BYTES);
    const source = f.split('-')[0];
    let current: LogLine | null = null;
    for (const raw of text.split('\n')) {
      const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (DEBUG|INFO|WARN|ERROR)\s+(.*)$/.exec(raw);
      if (m) {
        if (current) lines.push(current);
        current = { time: m[1], level: m[2].toLowerCase() as LogLevel, source, text: m[3] };
      } else if (current && raw.startsWith('    ')) current.text += `\n${raw.slice(4)}`;
    }
    if (current) lines.push(current);
  }
  const filtered = lines
    .filter(l => rank[l.level] >= min && (!search || l.text.toLowerCase().includes(search)))
    .sort((a, b) => a.time.localeCompare(b.time));
  return { lines: filtered.slice(-limit), files };
}
