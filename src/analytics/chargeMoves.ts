import type { DB } from '../db/connection.js';
import { localDate } from '../ingest/normalize.js';
import { addDays, dayInMonth, loadTransactions, NON_SPEND_KINDS, today, type Tx } from './common.js';

/**
 * Moving recurring charges from one card / bank account to another, and cancelling them (/charge-moves,
 * migration 20). The user builds the list from the old account's active recurring series, ticks each one when it's
 * done, and after every scrape `verifyChargeMoves` (pipeline, after refreshRecurring) checks:
 * - the charge showed up on the new account → verified;
 * - it was charged again on the old account after it was marked → failed (alert move_still_on_old / cancel_failed);
 * - a cancelled one passed its usual charge day (+ a few days, with the account scraped after it) clean → verified.
 */

export type MoveStatus = 'todo' | 'moved' | 'verified' | 'failed';

export interface ChargeMove {
  id: number;
  recurringSeriesId: number | null;
  merchantKey: string;
  description: string;
  fromAccountId: string;
  fromName: string;
  /** null = cancelled */
  toAccountId: string | null;
  toName: string | null;
  amount: number;
  dayOfMonth: number | null;
  status: MoveStatus;
  markedAt: string | null;
  verifiedAt: string | null;
  /** the row that verified it (on the new account) or failed it (on the old one) */
  evidence: { id: number; accountId: string; date: string; amount: number; description: string } | null;
  notes: string | null;
}

export interface MoveCandidate {
  seriesId: number;
  merchantKey: string;
  description: string;
  kind: string;
  amount: number;
  dayOfMonth: number | null;
  lastDate: string | null;
  categoryName: string | null;
  /** already on an open list (todo / moved / failed) from this account */
  listed: boolean;
}

/**
 * A charge to move happens about once a month: the recurring window is 130 days, so ≤ 6 rows. A supermarket visited
 * every week is "recurring" too, but there's nothing to move.
 */
const MAX_OCCURRENCES = 6;
/** Days after the usual charge day before a cancelled charge counts as stopped. */
const CANCEL_GRACE_DAYS = 5;
/** The new account may have been charged a bit before the user ticked "moved". */
const NEW_ACCOUNT_LOOKBACK_DAYS = 14;

/** Card companies write the same merchant a bit differently ("NETFLIX.COM" / "NETFLIX"). */
export function sameMerchant(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.includes(short);
}

/** A charge of about the usual amount: ±25% on the new account, ±50% on the old one (a price change shouldn't hide it). */
const fits = (t: Tx, amount: number, tolerance: number) =>
  t.amount < 0 && !NON_SPEND_KINDS.has(t.kind) && t.txnType !== 'installments'
  && Math.abs(Math.abs(t.amount) - amount) <= Math.max(5, amount * tolerance);

/** The first time the usual charge day comes after `date` (the same day counts as after only if later in the month). */
export function nextChargeDay(date: string, day: number | null): string {
  if (day == null) return addDays(date, 31);
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)) - 1;
  const thisMonth = dayInMonth(y, m, day);
  return thisMonth > date ? thisMonth : dayInMonth(m === 11 ? y + 1 : y, (m + 1) % 12, day);
}

interface MoveRow {
  id: number; recurring_series_id: number | null; merchant_key: string; description: string; from_account_id: string;
  to_account_id: string | null; amount: number; day_of_month: number | null; status: MoveStatus; marked_at: string | null;
  verified_at: string | null; evidence_txn_id: number | null; notes: string | null;
}

/** Re-check every move the user marked (and the verified ones: a cancelled charge may come back). */
export function verifyChargeMoves(db: DB, asOf = today(), txs: Tx[] = loadTransactions(db)): { verified: number; failed: number } {
  const rows = db.prepare(`SELECT * FROM charge_moves WHERE status IN ('moved', 'verified') AND marked_at IS NOT NULL`).all() as MoveRow[];
  const scraped = new Map((db.prepare(`SELECT id, last_scraped_at FROM accounts`).all() as { id: string; last_scraped_at: string | null }[])
    .map(a => [a.id, a.last_scraped_at?.slice(0, 10) ?? null]));
  const set = db.prepare(`UPDATE charge_moves SET status = ?, verified_at = ?, evidence_txn_id = ? WHERE id = ?`);
  let verified = 0, failed = 0;
  for (const m of rows) {
    const since = m.marked_at!.slice(0, 10);
    const again = txs.filter(t => t.accountId === m.from_account_id && t.merchant === m.merchant_key && t.date > since && fits(t, m.amount, 0.5))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (again.length) {
      if (m.status !== 'failed') { set.run('failed', null, again.at(-1)!.id, m.id); failed++; }
      continue;
    }
    if (m.status === 'verified') continue;
    if (m.to_account_id) {
      const hit = txs.filter(t => t.accountId === m.to_account_id && sameMerchant(t.merchant, m.merchant_key)
        && t.date >= addDays(since, -NEW_ACCOUNT_LOOKBACK_DAYS) && fits(t, m.amount, 0.25))
        .sort((a, b) => a.date.localeCompare(b.date))[0];
      if (hit) { set.run('verified', asOf, hit.id, m.id); verified++; }
    } else {
      // cancelled: its usual day passed with room to spare, and the old account was scraped after that
      const due = addDays(nextChargeDay(since, m.day_of_month), CANCEL_GRACE_DAYS);
      const last = scraped.get(m.from_account_id);
      if (asOf > due && last != null && last >= due) { set.run('verified', asOf, null, m.id); verified++; }
    }
  }
  return { verified, failed };
}

/** All moves and cancellations, newest list first. */
export function listChargeMoves(db: DB): ChargeMove[] {
  const rows = db.prepare(`
    SELECT m.*, COALESCE(f.display_name, f.id) AS from_name, COALESCE(t.display_name, t.id) AS to_name,
      e.account_id AS e_account, e.date AS e_date, e.charged_amount AS e_amount, e.description AS e_description
    FROM charge_moves m
    JOIN accounts f ON f.id = m.from_account_id
    LEFT JOIN accounts t ON t.id = m.to_account_id
    LEFT JOIN transactions e ON e.id = m.evidence_txn_id
    ORDER BY m.from_account_id, COALESCE(m.to_account_id, ''), m.description
  `).all() as (MoveRow & { from_name: string; to_name: string | null; e_account: string | null; e_date: string | null; e_amount: number | null; e_description: string | null })[];
  return rows.map(r => ({
    id: r.id, recurringSeriesId: r.recurring_series_id, merchantKey: r.merchant_key, description: r.description,
    fromAccountId: r.from_account_id, fromName: r.from_name, toAccountId: r.to_account_id, toName: r.to_name,
    amount: r.amount, dayOfMonth: r.day_of_month, status: r.status, markedAt: r.marked_at, verifiedAt: r.verified_at,
    evidence: r.evidence_txn_id && r.e_date ? {
      id: r.evidence_txn_id, accountId: r.e_account!, date: localDate(r.e_date), amount: r.e_amount!, description: r.e_description!,
    } : null,
    notes: r.notes,
  }));
}

/** The active recurring charges of an account (subscriptions, bills, standing orders, loans) to choose from. */
export function moveCandidates(db: DB, accountId: string, txs: Tx[] = loadTransactions(db), onceAMonth = true): MoveCandidate[] {
  const series = db.prepare(`SELECT s.id, s.merchant_key, s.kind, s.typical_amount, s.typical_day, s.last_date, c.name AS category_name
    FROM recurring_series s LEFT JOIN categories c ON c.id = s.category_id
    WHERE s.account_id = ? AND s.active = 1 AND s.kind IN ('subscription', 'bill', 'loan') AND s.occurrences <= ? ORDER BY s.typical_amount DESC`).all(accountId, onceAMonth ? MAX_OCCURRENCES : 1e9) as {
      id: number; merchant_key: string; kind: string; typical_amount: number; typical_day: number | null; last_date: string | null; category_name: string | null;
    }[];
  const open = new Set((db.prepare(`SELECT merchant_key FROM charge_moves WHERE from_account_id = ? AND status IN ('todo', 'moved', 'failed')`)
    .pluck().all(accountId) as string[]));
  return series.map(s => {
    const sample = txs.filter(t => t.accountId === accountId && t.merchant === s.merchant_key).sort((a, b) => b.date.localeCompare(a.date))[0];
    return {
      seriesId: s.id, merchantKey: s.merchant_key, description: sample?.description ?? s.merchant_key, kind: s.kind,
      amount: Math.abs(s.typical_amount), dayOfMonth: s.typical_day, lastDate: s.last_date, categoryName: s.category_name,
      listed: open.has(s.merchant_key),
    };
  });
}

/**
 * Put recurring series on the list: moving them to `toAccountId`, or cancelling them (null). `marked` = already done
 * (e.g. "I cancelled it" from the subscriptions list): starts as moved from today. Series already listed are skipped.
 */
export function addChargeMoves(db: DB, fromAccountId: string, toAccountId: string | null, seriesIds: number[],
  opts: { marked?: boolean; asOf?: string } = {}): number[] {
  // a series the user picked by hand (e.g. from the subscriptions list) counts even if it's charged more than once a month
  const candidates = new Map(moveCandidates(db, fromAccountId, loadTransactions(db), false).map(c => [c.seriesId, c]));
  const insert = db.prepare(`INSERT INTO charge_moves (recurring_series_id, merchant_key, description, from_account_id, to_account_id,
    amount, day_of_month, status, marked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ids: number[] = [];
  db.transaction(() => {
    for (const id of seriesIds) {
      const c = candidates.get(id);
      if (!c || c.listed) continue;
      ids.push(Number(insert.run(id, c.merchantKey, c.description, fromAccountId, toAccountId, c.amount, c.dayOfMonth,
        opts.marked ? 'moved' : 'todo', opts.marked ? (opts.asOf ?? today()) : null).lastInsertRowid));
    }
  })();
  return ids;
}

/** The user ticked it (moved: from today, again after a failure too) or unticked it (todo). */
export function markChargeMove(db: DB, id: number, status: 'todo' | 'moved', asOf = today()): void {
  db.prepare(`UPDATE charge_moves SET status = ?, marked_at = ?, verified_at = NULL, evidence_txn_id = NULL WHERE id = ?`)
    .run(status, status === 'moved' ? asOf : null, id);
}
