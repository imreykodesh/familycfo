/**
 * Closing a month (סגירת חודש) and the monthly report. After a cycle ends, a short list of checks says whether its
 * numbers can be trusted: every account has rows to the end, no open duplicates, nothing uncategorized, fixed items
 * that didn't show up (asked, not concluded: ended / will still come / paid another way), suggested links and planned
 * expenses waiting. Closing stores a snapshot with a signature, so later changes to the month are noticed.
 */
import type { DB } from '../db/connection.js';
import {
  addDays, cycleByKey, cycleFor, cycleStartDay, dateInCycle, loadTransactions, round, today, type Cycle, type Tx,
} from './common.js';
import { summarizeCycle, spendBaseline } from './cashflow.js';
import { alreadyPosted } from './forecast.js';
import { listScheduled } from './scheduled.js';
import { findDuplicateCharges } from './alerts.js';
import { budgetStatus } from './budgets.js';
import { buildRecommendations } from './recommendations.js';
import { MANUAL_ACCOUNT_ID } from '../db/migrations.js';

export type CheckStatus = 'ok' | 'warn' | 'ask';
export type FixedAnswer = 'ended' | 'later' | 'other';

export interface MonthCheck {
  id: string;
  kind: 'account' | 'duplicates' | 'uncategorized' | 'fixed' | 'links' | 'planned';
  status: CheckStatus;
  title: string;
  detail?: string;
  /** a screen that shows the rows behind it */
  href?: string;
  /** the user said it's fine (warn → ok) */
  approved?: boolean;
  /** fixed items: what the user answered */
  answer?: FixedAnswer | null;
  amount?: number;
}

export interface MonthCloseState {
  cycle: Cycle;
  /** the cycle hasn't ended yet: nothing to close */
  open: boolean;
  checks: MonthCheck[];
  /** checks still needing attention (warn / unanswered ask) */
  todo: number;
  closed: { at: string; changed: boolean } | null;
}

const fmtDay = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}`;
const ils = (n: number) => `₪${Math.round(Math.abs(n)).toLocaleString('he-IL')}`;

function answers(db: DB, key: string): Map<string, string> {
  return new Map((db.prepare(`SELECT check_id, answer FROM month_close_checks WHERE cycle = ?`).all(key) as { check_id: string; answer: string }[])
    .map(r => [r.check_id, r.answer]));
}

const inCycle = (t: Tx, c: Cycle) => t.effectiveDate >= c.start && t.effectiveDate <= c.end;

/** Rows and total of a cycle: the month's signature — changes after closing show up as a different one. */
export function monthSignature(txs: Tx[], c: Cycle): { n: number; sum: number } {
  const rows = txs.filter(t => inCycle(t, c));
  return { n: rows.length, sum: Math.round(rows.reduce((s, t) => s + Math.abs(t.amount), 0)) };
}

export function monthChecks(db: DB, key: string, txs: Tx[] = loadTransactions(db)): MonthCheck[] {
  const cycle = cycleByKey(key, cycleStartDay(db));
  const given = answers(db, key);
  const checks: MonthCheck[] = [];
  const cycleHref = (extra = '') => `/transactions?cycle=${key}${extra}`;

  // 1) every account that had rows in this cycle or the three before it has rows to the end
  const since = cycleByKey(addDays(cycle.start, -95).slice(0, 7), cycleStartDay(db)).start;
  const accounts = db.prepare(`SELECT id, kind, display_name, last_scraped_at FROM accounts WHERE active = 1 AND id != ? ORDER BY kind, id`)
    .all(MANUAL_ACCOUNT_ID) as { id: string; kind: string; display_name: string | null; last_scraped_at: string | null }[];
  for (const a of accounts) {
    const rows = txs.filter(t => t.accountId === a.id && t.date >= since && t.date <= cycle.end);
    if (!rows.length) continue;
    const mine = rows.filter(t => t.date >= cycle.start);
    const last = mine.map(t => t.date).sort().at(-1) ?? null;
    const scraped = a.last_scraped_at?.slice(0, 10) ?? null;
    const notUpdated = !scraped || scraped < cycle.end;
    const name = a.display_name ?? a.id;
    const id = `account:${a.id}`;
    let check: MonthCheck;
    if (!last) {
      check = { id, kind: 'account', status: 'warn', title: `${name} — אין תנועות בחודש הזה`,
        detail: notUpdated ? `החשבון לא עודכן מאז ${scraped ? fmtDay(scraped) : 'אף פעם'}. כדאי לעדכן נתונים.` : 'ייתכן שבאמת לא היו בו תנועות.', href: '/' };
    } else if (last < addDays(cycle.end, -7) && notUpdated) {
      check = { id, kind: 'account', status: 'warn', title: `${name} — תנועות עד ${fmtDay(last)} בלבד`,
        detail: scraped ? `העדכון האחרון היה ב-${fmtDay(scraped)}, לפני סוף החודש.` : 'לא ידוע מתי החשבון עודכן לאחרונה.', href: '/' };
    } else {
      check = { id, kind: 'account', status: 'ok', title: `${name} — ${mine.length} תנועות, עד ${fmtDay(last)}` };
    }
    checks.push(check);
  }

  // 2) open duplicates
  const dups = findDuplicateCharges(txs, cycle.start).filter(([a, b]) => a.date <= cycle.end && b.date <= cycle.end);
  checks.push(dups.length
    ? { id: 'duplicates', kind: 'duplicates', status: 'warn', title: dups.length === 1 ? 'חיוב אחד שאולי נרשם פעמיים' : `${dups.length} חיובים שאולי נרשמו פעמיים`,
      detail: dups.slice(0, 3).map(([a]) => `${a.description} ${ils(a.amount)}`).join(' · '), href: cycleHref(`&search=${encodeURIComponent(dups[0][0].description)}`) }
    : { id: 'duplicates', kind: 'duplicates', status: 'ok', title: 'אין חיובים כפולים' });

  // 3) uncategorized expenses
  const uncategorized = txs.filter(t => inCycle(t, cycle) && t.kind === 'expense' && t.categoryId == null);
  checks.push(uncategorized.length
    ? { id: 'uncategorized', kind: 'uncategorized', status: 'warn', title: `${uncategorized.length} הוצאות בלי קטגוריה`,
      detail: `${ils(uncategorized.reduce((s, t) => s + t.amount, 0))} שלא נספרים באף תקציב.`, href: cycleHref('&review=1') }
    : { id: 'uncategorized', kind: 'uncategorized', status: 'ok', title: 'לכל ההוצאות יש קטגוריה' });

  // 4) confirmed fixed items that didn't show up — a question, not a conclusion
  for (const item of listScheduled(db).filter(s => s.status === 'confirmed' && s.kind !== 'card_charge' && s.bank_account_id)) {
    const id = `fixed:${item.id}`;
    const answer = (given.get(id) as FixedAnswer | undefined) ?? null;
    const date = dateInCycle(cycle, item.day_of_month);
    if (item.start_date && date < item.start_date) continue;
    // "ended" for this month sets end_date to the day before it — still show the answered question
    if (item.end_date && date > item.end_date && answer !== 'ended') continue;
    if (!txs.some(t => t.accountId === item.bank_account_id && t.date >= cycle.start && t.date <= cycle.end)) continue;
    if (alreadyPosted(item, date, txs)) continue;
    const isIncome = item.amount > 0;
    checks.push({
      id, kind: 'fixed', status: answer ? 'ok' : 'ask', answer, amount: item.amount,
      title: `${item.name} — בדרך כלל ${ils(item.amount)} ב-${item.day_of_month} לחודש, והחודש ${isIncome ? 'לא נכנס' : 'לא ירד'}`,
      detail: answer === 'ended' ? (isIncome ? 'סימנתם: ההכנסה הזו הסתיימה.' : 'סימנתם: החיוב הסתיים — הכסף הזה מתפנה מעכשיו.')
        : answer === 'later' ? 'סימנתם: עוד יגיע.' : answer === 'other' ? 'סימנתם: שולם בדרך אחרת.' : 'מה קרה איתו?',
    });
  }

  // 5) payback / refund links waiting for a yes or no
  const links = db.prepare(`SELECT COUNT(*) FROM transaction_links l JOIN transactions t ON t.id = l.to_txn_id
    WHERE l.status = 'suggested' AND substr(t.date, 1, 10) BETWEEN ? AND ?`).pluck().get(addDays(cycle.start, -1), cycle.end) as number;
  if (links) checks.push({ id: 'links', kind: 'links', status: 'warn', title: `${links} החזרים (ביט / זיכוי) שמחכים לאישור`,
    detail: 'עד שמאשרים, ההוצאה נספרת במלואה.', href: '/fixed' });

  // 6) planned expenses of this month that never got charged
  const planned = db.prepare(`SELECT COUNT(*) FROM planned_items WHERE status = 'planned' AND date <= ?`).pluck().get(cycle.end) as number;
  if (planned) checks.push({ id: 'planned', kind: 'planned', status: 'warn', title: `${planned} הוצאות מתוכננות שעוד לא חויבו`,
    detail: 'עדיין רלוונטיות? אפשר לדחות או לבטל.', href: '/fixed' });

  for (const c of checks) {
    if (c.status === 'warn' && given.get(c.id) === 'ok') { c.status = 'ok'; c.approved = true; c.detail = 'אישרתם שזה בסדר.'; }
  }
  return checks;
}

export function monthCloseState(db: DB, key?: string, asOf = today()): MonthCloseState {
  const startDay = cycleStartDay(db);
  const cycle = key ? cycleByKey(key, startDay) : lastEndedCycle(asOf, startDay);
  const txs = loadTransactions(db);
  const open = cycle.end >= asOf;
  const checks = open ? [] : monthChecks(db, cycle.key, txs);
  const row = db.prepare(`SELECT closed_at, snapshot_json FROM month_closes WHERE cycle = ?`).get(cycle.key) as { closed_at: string; snapshot_json: string } | undefined;
  let closed: MonthCloseState['closed'] = null;
  if (row) {
    const sig = (JSON.parse(row.snapshot_json) as { sig?: { n: number; sum: number } }).sig;
    const now = monthSignature(txs, cycle);
    closed = { at: row.closed_at, changed: !sig || sig.n !== now.n || sig.sum !== now.sum };
  }
  return { cycle, open, checks, todo: checks.filter(c => c.status !== 'ok').length, closed };
}

/** The most recent cycle that has ended. */
export function lastEndedCycle(asOf: string, startDay: number): Cycle {
  return cycleFor(addDays(cycleFor(asOf, startDay).start, -1), startDay);
}

/** The ended cycles of the last year, newest first, with their close status. */
export function closeHistory(db: DB, asOf = today(), n = 12): { key: string; start: string; end: string; closed: boolean }[] {
  const startDay = cycleStartDay(db);
  const closed = new Set(db.prepare(`SELECT cycle FROM month_closes`).pluck().all() as string[]);
  const out: { key: string; start: string; end: string; closed: boolean }[] = [];
  for (let c = lastEndedCycle(asOf, startDay); out.length < n; c = cycleFor(addDays(c.start, -1), startDay)) out.push({ ...c, closed: closed.has(c.key) });
  return out;
}

/** Store the user's answer to a check (null removes it). "ended" also ends the fixed item from this month. */
export function answerCheck(db: DB, key: string, checkId: string, answer: string | null): void {
  const cycle = cycleByKey(key, cycleStartDay(db));
  const fixedId = checkId.startsWith('fixed:') ? Number(checkId.slice(6)) : null;
  const endedOn = addDays(cycle.start, -1);
  db.transaction(() => {
    const prev = db.prepare(`SELECT answer FROM month_close_checks WHERE cycle = ? AND check_id = ?`).pluck().get(key, checkId) as string | undefined;
    if (answer) {
      db.prepare(`INSERT INTO month_close_checks (cycle, check_id, answer) VALUES (?, ?, ?)
        ON CONFLICT(cycle, check_id) DO UPDATE SET answer = excluded.answer, updated_at = CURRENT_TIMESTAMP`).run(key, checkId, answer);
    } else {
      db.prepare(`DELETE FROM month_close_checks WHERE cycle = ? AND check_id = ?`).run(key, checkId);
    }
    if (fixedId != null) {
      if (answer === 'ended') db.prepare(`UPDATE scheduled_items SET end_date = ? WHERE id = ? AND (end_date IS NULL OR end_date > ?)`).run(endedOn, fixedId, endedOn);
      else if (prev === 'ended') db.prepare(`UPDATE scheduled_items SET end_date = NULL WHERE id = ? AND end_date = ?`).run(fixedId, endedOn);
    }
  })();
}

export function closeMonth(db: DB, key: string): void {
  const cycle = cycleByKey(key, cycleStartDay(db));
  const txs = loadTransactions(db);
  const s = summarizeCycle(txs, cycle);
  const snapshot = {
    income: s.income, spend: s.spend, fixed: s.fixed, dynamic: s.dynamic, net: s.net, savingsDeposits: s.savingsDeposits,
    byCategory: s.byCategory.map(c => ({ categoryId: c.categoryId, name: c.name, spend: c.spend })), sig: monthSignature(txs, cycle),
  };
  db.prepare(`INSERT INTO month_closes (cycle, closed_at, snapshot_json) VALUES (?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(cycle) DO UPDATE SET closed_at = CURRENT_TIMESTAMP, snapshot_json = excluded.snapshot_json`).run(key, JSON.stringify(snapshot));
}

export function reopenMonth(db: DB, key: string): void {
  db.prepare(`DELETE FROM month_closes WHERE cycle = ?`).run(key);
}

// ---- the monthly report ----------------------------------------------------------------------------

export interface MonthReport {
  cycle: Cycle;
  income: number; spend: number; fixed: number; dynamic: number; net: number; savingsDeposits: number;
  /** the same numbers on average over the complete months before it */
  average: { income: number; spend: number; net: number; months: number };
  /** the largest categories (top level) vs their average */
  categories: { categoryId: number | null; name: string; spend: number; average: number; delta: number }[];
  overBudget: { categoryId: number; name: string; budget: number; spent: number }[];
  /** fixed items that ended (answered in the month close): money freed every month from now on */
  ended: { name: string; amount: number }[];
  freedMonthly: number;
  debts: { total: number; monthly: number };
  recommendations: { title: string; detail: string; monthlySaving: number }[];
  closed: MonthCloseState['closed'];
  todo: number;
}

type CatSpend = { categoryId: number | null; parentId: number | null; parentName: string | null; name: string; spend: number };
function topLevel(rows: CatSpend[]): Map<string, { categoryId: number | null; name: string; spend: number }> {
  const out = new Map<string, { categoryId: number | null; name: string; spend: number }>();
  for (const c of rows) {
    const id = c.parentId ?? c.categoryId;
    const k = String(id ?? 'none');
    const g = out.get(k) ?? { categoryId: id, name: c.parentName ?? c.name, spend: 0 };
    g.spend += c.spend;
    out.set(k, g);
  }
  return out;
}

export function monthReport(db: DB, key?: string, asOf = today()): MonthReport {
  const state = monthCloseState(db, key, asOf);
  const cycle = state.cycle;
  const txs = loadTransactions(db);
  const s = summarizeCycle(txs, cycle);
  const base = spendBaseline(db, {}, 6, cycle.start);
  const n = base.history.length;
  const avg = (f: (h: typeof base.history[number]) => number) => (n ? round(base.history.reduce((sum, h) => sum + f(h), 0) / n) : 0);

  const past = base.history.map(h => topLevel(h.byCategory));
  const categories = [...topLevel(s.byCategory).entries()].map(([k, c]) => {
    const average = n ? round(past.reduce((sum, m) => sum + (m.get(k)?.spend ?? 0), 0) / n) : 0;
    return { categoryId: c.categoryId, name: c.name, spend: round(c.spend), average, delta: round(c.spend - average) };
  }).filter(c => c.spend > 0).sort((a, b) => b.spend - a.spend).slice(0, 8);

  const overBudget = budgetStatus(db, { cycleKey: cycle.key, asOf: addDays(cycle.end, 1) })
    .filter(b => b.budget != null && b.spent > b.budget)
    .map(b => ({ categoryId: b.categoryId, name: b.categoryName, budget: b.budget!, spent: round(b.spent) }));

  const ended = state.checks.filter(c => c.kind === 'fixed' && c.answer === 'ended' && (c.amount ?? 0) < 0)
    .map(c => ({ name: c.title.split(' — ')[0], amount: Math.abs(c.amount!) }));

  const debt = db.prepare(`SELECT COALESCE(SUM(s.balance), 0) AS total, COALESCE(SUM(l.monthly_payment), 0) AS monthly FROM liabilities l
    LEFT JOIN liability_snapshots s ON s.id = (SELECT id FROM liability_snapshots WHERE liability_id = l.id ORDER BY date DESC, id DESC LIMIT 1)
    WHERE l.archived = 0`).get() as { total: number; monthly: number };

  return {
    cycle, income: s.income, spend: s.spend, fixed: s.fixed, dynamic: s.dynamic, net: s.net, savingsDeposits: s.savingsDeposits,
    average: { income: avg(h => h.income), spend: avg(h => h.spend), net: avg(h => h.net), months: n },
    categories, overBudget, ended, freedMonthly: round(ended.reduce((sum, e) => sum + e.amount, 0)),
    debts: { total: round(debt.total), monthly: round(debt.monthly) },
    recommendations: buildRecommendations(db, asOf).slice(0, 3).map(r => ({ title: r.title, detail: r.detail, monthlySaving: r.monthlySaving })),
    closed: state.closed, todo: state.todo,
  };
}
