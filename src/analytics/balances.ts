import type { DB } from '../db/connection.js';
import { localDate } from '../ingest/normalize.js';
import { addDays, cycleFor, cycleStartDay, round, today } from './common.js';

/**
 * Day-by-day balance of each bank account, as far back as its scraped history goes. The scrape stores only the
 * current balance (`balances`), so the past is rebuilt backwards from it: the balance at the end of a day = the
 * latest balance − everything that moved after that day. (Checked against the bank's own "balance after" on each
 * row — Discount's BalanceAfterOperation, Mizrahi's MC02YitraEZ — they agree.)
 */

export interface BalanceMonth {
  /** the app's month (cycle) key */
  month: string;
  /** balance at the start of the month (end of the day before), at its end, and the lowest / highest end of day */
  start: number;
  end: number;
  min: number;
  minDate: string;
  max: number;
  /** days that ended below zero */
  daysNegative: number;
}

export interface AccountBalanceHistory {
  accountId: string;
  name: string;
  currentBalance: number;
  /** when the current balance was read (the last scrape) */
  asOf: string;
  /** the first and last day the bank returned rows for: before historyFrom there is no data, not a zero */
  historyFrom: string | null;
  historyTo: string | null;
  /** balance before the first row of the history */
  balanceBeforeHistory: number;
  /** current balance < 0: the first day of the unbroken run of negative days that leads to today */
  negativeSince: string | null;
  /** the run is negative already on the first day of the history: it started before the data does */
  negativeSinceBeforeHistory: boolean;
  monthly: BalanceMonth[];
  daily?: { date: string; balance: number }[];
}

export function balanceHistory(db: DB, opts: { account?: string; from?: string; to?: string; daily?: boolean } = {}): AccountBalanceHistory[] {
  const accounts = db.prepare(`
    SELECT a.id, COALESCE(a.display_name, a.id) AS name, b.balance, b.timestamp
    FROM accounts a
    JOIN balances b ON b.id = (SELECT id FROM balances WHERE account_id = a.id ORDER BY timestamp DESC, id DESC LIMIT 1)
    WHERE a.kind = 'bank' ${opts.account ? 'AND a.id = ?' : ''}
    ORDER BY a.id
  `).all(...(opts.account ? [opts.account] : [])) as { id: string; name: string; balance: number; timestamp: string }[];
  const startDay = cycleStartDay(db);
  const end = today();

  return accounts.map(acc => {
    // every row of the account, excluded or not: they all moved the balance
    const rows = db.prepare(`SELECT date, charged_amount AS amount FROM transactions WHERE account_id = ?`).all(acc.id) as { date: string; amount: number }[];
    const moved = new Map<string, number>();
    for (const r of rows) {
      const d = localDate(r.date);
      moved.set(d, (moved.get(d) ?? 0) + (r.amount ?? 0));
    }
    const days = [...moved.keys()].sort();
    const historyFrom = days[0] ?? null;
    const historyTo = days.at(-1) ?? null;

    // end-of-day balances from the first day of history to today, walking back from the current balance
    const series: { date: string; balance: number }[] = [];
    let balance = acc.balance;
    const last = historyTo && historyTo > end ? historyTo : end;
    if (historyFrom) {
      for (let d = last; d >= historyFrom; d = addDays(d, -1)) {
        series.push({ date: d, balance: round(balance) });
        balance -= moved.get(d) ?? 0;
      }
      series.reverse();
    }
    const balanceBeforeHistory = round(balance);

    let negativeSince: string | null = null;
    if (series.length && series.at(-1)!.balance < 0) {
      let i = series.length - 1;
      while (i > 0 && series[i - 1].balance < 0) i--;
      negativeSince = series[i].date;
    }

    const inRange = series.filter(p => (!opts.from || p.date >= opts.from) && (!opts.to || p.date <= opts.to));
    const months = new Map<string, BalanceMonth>();
    let prev = opts.from ? (series.filter(p => p.date < opts.from!).at(-1)?.balance ?? balanceBeforeHistory) : balanceBeforeHistory;
    for (const p of inRange) {
      const key = cycleFor(p.date, startDay).key;
      let m = months.get(key);
      if (!m) {
        m = { month: key, start: prev, end: p.balance, min: p.balance, minDate: p.date, max: p.balance, daysNegative: 0 };
        months.set(key, m);
      }
      m.end = p.balance;
      if (p.balance < m.min) { m.min = p.balance; m.minDate = p.date; }
      if (p.balance > m.max) m.max = p.balance;
      if (p.balance < 0) m.daysNegative++;
      prev = p.balance;
    }

    return {
      accountId: acc.id,
      name: acc.name,
      currentBalance: acc.balance,
      asOf: acc.timestamp,
      historyFrom,
      historyTo,
      balanceBeforeHistory,
      negativeSince,
      negativeSinceBeforeHistory: !!negativeSince && negativeSince === historyFrom && balanceBeforeHistory < 0,
      monthly: [...months.values()],
      ...(opts.daily ? { daily: inRange } : {}),
    };
  });
}

export interface DataCoverage {
  accountId: string;
  kind: string;
  name: string;
  firstDate: string | null;
  lastDate: string | null;
  rows: number;
}

/** What the database holds per account: before an account's firstDate there is no data from it (not zero). */
export function dataCoverage(db: DB): DataCoverage[] {
  return (db.prepare(`
    SELECT a.id AS accountId, a.kind, COALESCE(a.display_name, a.id) AS name, MIN(t.date) AS firstDate, MAX(t.date) AS lastDate, COUNT(t.id) AS rows
    FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
    GROUP BY a.id HAVING rows > 0 ORDER BY a.kind, a.id
  `).all() as DataCoverage[]).map(c => ({
    ...c,
    firstDate: c.firstDate ? localDate(c.firstDate) : null,
    lastDate: c.lastDate ? localDate(c.lastDate) : null,
  }));
}
