import type { DB } from '../db/connection.js';
import { addDays, loadTransactions, round, today, type Tx } from './common.js';

/**
 * Personal loans between people (/iou, migration 21): who owes whom, partial repayments, and suggestions — a Bit /
 * PayBox / transfer row that mentions the person, in the right direction and up to what's left, is offered as a
 * repayment; a row of the same amount around the date as the loan itself. A linked row becomes a `transfer`
 * (manual), since lending isn't spend and getting it back isn't income; unlinking restores its kind.
 */

export type IouDirection = 'owed_to_me' | 'i_owe';

export interface IouRow {
  id: number;
  direction: IouDirection;
  person: string;
  amount: number;
  date: string;
  dueDate: string | null;
  matchPattern: string | null;
  txnId: number | null;
  notes: string | null;
  doneAt: string | null;
  paid: number;
  remaining: number;
  overdue: boolean;
  payments: { id: number; date: string; amount: number; txnId: number | null; description: string | null }[];
  /** the loan's own row, when linked */
  source: { id: number; date: string; amount: number; description: string } | null;
  /** rows that look like a repayment (open loans only) */
  paymentCandidates: Candidate[];
  /** rows that look like the loan itself (when none is linked) */
  sourceCandidates: Candidate[];
}

export interface Candidate { id: number; date: string; amount: number; description: string; accountId: string }

interface Raw {
  id: number; direction: IouDirection; person: string; amount: number; date: string; due_date: string | null;
  match_pattern: string | null; txn_id: number | null; txn_prev_kind: string | null; rejected_txn_ids: string | null;
  notes: string | null; done_at: string | null;
}

const P2P = /ביט|bit|paybox|פייבוקס|פיי בוקס|העברה/i;
const SOURCE_WINDOW_DAYS = 10;

/** The text a row must contain to be about this person. */
export const iouPattern = (i: { person: string; match_pattern?: string | null; matchPattern?: string | null }) =>
  (i.match_pattern ?? i.matchPattern ?? i.person).trim().toLowerCase();

const mentions = (t: Tx, pattern: string) =>
  pattern.length >= 2 && (t.description.toLowerCase().includes(pattern) || (t.notes ?? '').toLowerCase().includes(pattern));

/** owed to me: the money left (−) and comes back (+); I owe: the reverse */
const sourceSign = (d: IouDirection) => (d === 'owed_to_me' ? -1 : 1);

/** Pure: candidate rows for one loan. `taken` = rows already linked to any loan. */
export function iouCandidates(i: Raw, remaining: number, txs: Tx[], taken: Set<number>): { payments: Candidate[]; source: Candidate[] } {
  const rejected = new Set<number>(i.rejected_txn_ids ? JSON.parse(i.rejected_txn_ids) : []);
  const pattern = iouPattern(i);
  const usable = (t: Tx) => !taken.has(t.id) && !rejected.has(t.id) && t.kind !== 'card_payment';
  const cand = (t: Tx): Candidate => ({ id: t.id, date: t.date, amount: t.amount, description: t.description, accountId: t.accountId });
  const back = -sourceSign(i.direction);
  const payments = i.done_at ? [] : txs
    .filter(t => usable(t) && Math.sign(t.amount) === back && t.date >= i.date && mentions(t, pattern) && Math.abs(t.amount) <= remaining + 1)
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3).map(cand);
  const source = i.txn_id ? [] : txs
    .filter(t => usable(t) && Math.sign(t.amount) === sourceSign(i.direction) && Math.abs(Math.abs(t.amount) - i.amount) <= 1
      && t.date >= addDays(i.date, -SOURCE_WINDOW_DAYS) && t.date <= addDays(i.date, SOURCE_WINDOW_DAYS)
      && (mentions(t, pattern) || P2P.test(t.description)))
    .sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(i.date)) - Math.abs(Date.parse(b.date) - Date.parse(i.date))).slice(0, 3).map(cand);
  return { payments, source };
}

export function listIous(db: DB, asOf = today(), txs: Tx[] = loadTransactions(db)): IouRow[] {
  const rows = db.prepare(`SELECT * FROM iou ORDER BY done_at IS NOT NULL, COALESCE(due_date, '9999'), date`).all() as Raw[];
  const payments = db.prepare(`SELECT p.*, t.description FROM iou_payments p LEFT JOIN transactions t ON t.id = p.txn_id ORDER BY p.date, p.id`).all() as
    { id: number; iou_id: number; date: string; amount: number; txn_id: number | null; description: string | null }[];
  const taken = new Set<number>([
    ...rows.filter(r => r.txn_id != null).map(r => r.txn_id!),
    ...payments.filter(p => p.txn_id != null).map(p => p.txn_id!),
  ]);
  const byId = new Map(txs.map(t => [t.id, t]));
  return rows.map(r => {
    const mine = payments.filter(p => p.iou_id === r.id);
    const paid = round(mine.reduce((s, p) => s + p.amount, 0));
    const remaining = round(Math.max(0, r.amount - paid));
    const c = iouCandidates(r, remaining, txs, taken);
    const src = r.txn_id != null ? byId.get(r.txn_id) : undefined;
    return {
      id: r.id, direction: r.direction, person: r.person, amount: r.amount, date: r.date, dueDate: r.due_date,
      matchPattern: r.match_pattern, txnId: r.txn_id, notes: r.notes, doneAt: r.done_at, paid, remaining,
      overdue: !r.done_at && !!r.due_date && r.due_date < asOf,
      payments: mine.map(p => ({ id: p.id, date: p.date, amount: p.amount, txnId: p.txn_id, description: p.description })),
      source: src ? { id: src.id, date: src.date, amount: src.amount, description: src.description } : null,
      paymentCandidates: c.payments, sourceCandidates: c.source,
    };
  });
}

// ---- making a linked row a transfer, and undoing it -------------------------------------------------------------

function neutralize(db: DB, txnId: number): string | null {
  const t = db.prepare(`SELECT kind, kind_source FROM transactions WHERE id = ?`).get(txnId) as { kind: string | null; kind_source: string | null } | undefined;
  if (!t) return null;
  db.prepare(`UPDATE transactions SET kind = 'transfer', kind_source = 'manual' WHERE id = ?`).run(txnId);
  return `${t.kind ?? ''}|${t.kind_source ?? ''}`;
}

function restore(db: DB, txnId: number | null, prev: string | null): void {
  if (txnId == null || prev == null) return;
  const [kind, source] = prev.split('|');
  db.prepare(`UPDATE transactions SET kind = ?, kind_source = ? WHERE id = ?`).run(kind || null, source || null, txnId);
}

const txnExists = (db: DB, id: number) => !!db.prepare(`SELECT 1 FROM transactions WHERE id = ?`).get(id);
const isTaken = (db: DB, id: number) => !!db.prepare(`SELECT 1 FROM iou WHERE txn_id = ? UNION SELECT 1 FROM iou_payments WHERE txn_id = ?`).get(id, id);

/** Closed when repaid in full; reopened when a payment is removed. */
function refreshDone(db: DB, iouId: number, asOf: string): void {
  const r = db.prepare(`SELECT amount, done_at, (SELECT COALESCE(SUM(amount), 0) FROM iou_payments WHERE iou_id = iou.id) AS paid FROM iou WHERE id = ?`)
    .get(iouId) as { amount: number; done_at: string | null; paid: number } | undefined;
  if (!r) return;
  if (r.paid >= r.amount - 0.01 && !r.done_at) db.prepare(`UPDATE iou SET done_at = ? WHERE id = ?`).run(asOf, iouId);
  if (r.paid < r.amount - 0.01 && r.done_at) db.prepare(`UPDATE iou SET done_at = NULL WHERE id = ?`).run(iouId);
}

export interface NewIou { direction: IouDirection; person: string; amount: number; date?: string; dueDate?: string | null; matchPattern?: string | null; notes?: string | null; txnId?: number | null }

export function createIou(db: DB, b: NewIou, asOf = today()): number {
  return db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO iou (direction, person, amount, date, due_date, match_pattern, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(b.direction, b.person.trim(), b.amount, b.date ?? asOf, b.dueDate || null, b.matchPattern?.trim() || null, b.notes || null).lastInsertRowid);
    if (b.txnId != null) setSource(db, id, b.txnId);
    return id;
  })();
}

/** Link the loan's own row (null = unlink). Returns an error message or null. */
export function setSource(db: DB, iouId: number, txnId: number | null): string | null {
  const cur = db.prepare(`SELECT txn_id, txn_prev_kind FROM iou WHERE id = ?`).get(iouId) as { txn_id: number | null; txn_prev_kind: string | null } | undefined;
  if (!cur) return 'not found';
  if (txnId != null && txnId !== cur.txn_id && (!txnExists(db, txnId) || isTaken(db, txnId))) return 'התנועה לא קיימת או כבר מקושרת';
  db.transaction(() => {
    restore(db, cur.txn_id, cur.txn_prev_kind);
    const prev = txnId != null ? neutralize(db, txnId) : null;
    db.prepare(`UPDATE iou SET txn_id = ?, txn_prev_kind = ? WHERE id = ?`).run(txnId, prev, iouId);
  })();
  return null;
}

/** A repayment: from a row (its date and amount, unless given) or typed by hand. Returns an error message or null. */
export function addIouPayment(db: DB, iouId: number, p: { date?: string; amount?: number; txnId?: number | null }, asOf = today()): string | null {
  if (!db.prepare(`SELECT 1 FROM iou WHERE id = ?`).get(iouId)) return 'not found';
  let { date, amount } = p;
  if (p.txnId != null) {
    if (!txnExists(db, p.txnId) || isTaken(db, p.txnId)) return 'התנועה לא קיימת או כבר מקושרת';
    const t = loadTransactions(db).find(x => x.id === p.txnId);
    date ??= t?.date;
    amount ??= t ? Math.abs(t.amount) : undefined;
  }
  if (!amount || !Number.isFinite(amount) || amount <= 0) return 'סכום לא תקין';
  db.transaction(() => {
    const prev = p.txnId != null ? neutralize(db, p.txnId) : null;
    db.prepare(`INSERT INTO iou_payments (iou_id, date, amount, txn_id, txn_prev_kind) VALUES (?, ?, ?, ?, ?)`)
      .run(iouId, date ?? asOf, round(amount!), p.txnId ?? null, prev);
    refreshDone(db, iouId, asOf);
  })();
  return null;
}

export function removeIouPayment(db: DB, iouId: number, paymentId: number, asOf = today()): void {
  const p = db.prepare(`SELECT txn_id, txn_prev_kind FROM iou_payments WHERE id = ? AND iou_id = ?`).get(paymentId, iouId) as { txn_id: number | null; txn_prev_kind: string | null } | undefined;
  if (!p) return;
  db.transaction(() => {
    restore(db, p.txn_id, p.txn_prev_kind);
    db.prepare(`DELETE FROM iou_payments WHERE id = ?`).run(paymentId);
    refreshDone(db, iouId, asOf);
  })();
}

/** "Not it": this row won't be suggested for this loan again. */
export function rejectIouCandidate(db: DB, iouId: number, txnId: number): void {
  const r = db.prepare(`SELECT rejected_txn_ids FROM iou WHERE id = ?`).get(iouId) as { rejected_txn_ids: string | null } | undefined;
  if (!r) return;
  const ids = new Set<number>(r.rejected_txn_ids ? JSON.parse(r.rejected_txn_ids) : []);
  ids.add(txnId);
  db.prepare(`UPDATE iou SET rejected_txn_ids = ? WHERE id = ?`).run(JSON.stringify([...ids]), iouId);
}

/** Delete a loan; every row linked to it gets its kind back. */
export function deleteIou(db: DB, iouId: number): void {
  db.transaction(() => {
    const r = db.prepare(`SELECT txn_id, txn_prev_kind FROM iou WHERE id = ?`).get(iouId) as { txn_id: number | null; txn_prev_kind: string | null } | undefined;
    if (r) restore(db, r.txn_id, r.txn_prev_kind);
    for (const p of db.prepare(`SELECT txn_id, txn_prev_kind FROM iou_payments WHERE iou_id = ?`).all(iouId) as { txn_id: number | null; txn_prev_kind: string | null }[]) {
      restore(db, p.txn_id, p.txn_prev_kind);
    }
    db.prepare(`DELETE FROM iou WHERE id = ?`).run(iouId);
  })();
}
