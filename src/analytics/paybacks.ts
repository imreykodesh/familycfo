import type { DB } from '../db/connection.js';
import { addDays, loadTransactions, type Tx } from './common.js';

// a payment app. "ביט" but not "ביטוח" (JS \b is ASCII-only, so an explicit lookahead)
const PAY_APP = /ביט(?![א-ת])|\bbit\b|paybox|פייבוקס|פיי ?בוקס/i;
const TRANSFER_IN = /העברה מ/;
// money sent to a person: only that person paying it back makes sense
const SENT_TO_PERSON = /ביט(?![א-ת])|\bbit\b|paybox|פייבוקס|פיי ?בוקס|העברה ל|העב' ?ל|הע\. ?ל|העברת כספים/i;
// cash and cheques: nobody "pays back" an ATM withdrawal
const CASH = /כספומט|משיכת שיק|משיכת מזומן|משיכה מכספומט/;
const MAX_SHARES = 6;
/** a share (1/2..1/6) is only guessed for a purchase this close to the payback */
const SHARE_DAYS = 14;
/** an inflow that comes this often is regular income (a stipend, a parent's monthly help), not a payback */
const REGULAR_INFLOW = 3;
/** words in transfer descriptions that aren't a name */
const GENERIC = new Set(['העברה', 'העברת', 'העב', 'כספים', 'חשבון', 'בנק', 'ביט', 'פייבוקס', 'זמן', 'פלוס', 'מאת', 'עבור',
  'החזר', 'תשלום', 'הפועלים', 'לאומי', 'דיסקונט', 'מזרחי', 'טפחות', 'נייד', 'לאחר', 'אחר', 'מיידית', 'בסניף']);

/** The name-like words of a description, also without a leading מ / ל / ו ("מויספיש" → "ויספיש"). */
function nameWords(description: string): Set<string> {
  const out = new Set<string>();
  for (const w of description.replace(/[^א-ת\s]+/g, ' ').split(/\s+/)) {
    for (const v of [w, w.replace(/^[מלו]/, '')]) if (v.length >= 3 && !GENERIC.has(v)) out.add(v);
  }
  return out;
}

/** Two transfer descriptions that share a name ("העברה מכהן דוד" / "העברה לכהן דוד"). */
export function samePerson(a: string, b: string): boolean {
  const wa = nameWords(a);
  return [...nameWords(b)].some(w => wa.has(w));
}

export interface PaybackSuggestion {
  inflowId: number;
  expenseId: number;
  type: 'refund' | 'payback';
  amount: number;
  reason: string;
}

/**
 * Suggest which expense an inflow pays back (#Bit matching). Only what a person plausibly paid back:
 * - Bit / PayBox: an expense of the same amount within 30 days, or a share of it (1/2..1/6) for one within 14 days;
 * - a bank transfer in: an expense of exactly that amount within 14 days;
 * - money sent to a person (Bit, transfer) only when it comes back from the same person, in full.
 * Never a fixed expense or a cash withdrawal, and never an inflow that comes regularly (that's income).
 * Card credits aren't suggested: a refund already lowers the spend of its category.
 */
export function findPaybackCandidates(txs: Tx[], existing: Set<string>): PaybackSuggestion[] {
  const expenses = txs.filter(t => t.kind === 'expense' && !t.fixed && !CASH.test(t.description));
  const out: PaybackSuggestion[] = [];
  const usedInflows = new Set([...existing].map(k => Number(k.split('|')[0])));
  const inflows = txs.filter(t => t.amount > 0 && !['transfer', 'card_payment', 'refund'].includes(t.kind) && t.accountKind !== 'card');
  const timesSeen = new Map<string, number>();
  for (const t of inflows) timesSeen.set(t.merchant, (timesSeen.get(t.merchant) ?? 0) + 1);

  for (const inflow of inflows) {
    if (usedInflows.has(inflow.id)) continue;
    const app = PAY_APP.test(inflow.description);
    // Bit rows often all read the same ("הפועלים-ביט"), so only a bank transfer can look regular
    if (!app && (!TRANSFER_IN.test(inflow.description) || (timesSeen.get(inflow.merchant) ?? 0) >= REGULAR_INFLOW)) continue;

    const windowStart = addDays(inflow.date, app ? -30 : -SHARE_DAYS);
    const shareStart = addDays(inflow.date, -SHARE_DAYS);
    const candidates = expenses
      .filter(e => e.date >= windowStart && e.date <= inflow.date && !existing.has(`${inflow.id}|${e.id}`))
      .sort((a, b) => b.date.localeCompare(a.date));

    let best: PaybackSuggestion | undefined;
    for (const e of candidates) {
      const total = -e.amount;
      const sent = SENT_TO_PERSON.test(e.description);
      if (sent && !samePerson(inflow.description, e.description)) continue;
      const tolerance = app || sent ? Math.max(1, inflow.amount * 0.02) : 0.5;
      const maxShares = app && !sent && e.date >= shareStart ? MAX_SHARES : 1;
      for (let people = 1; people <= maxShares && !best; people++) {
        if (Math.abs(total / people - inflow.amount) <= tolerance) {
          best = { inflowId: inflow.id, expenseId: e.id, type: 'payback', amount: inflow.amount,
            reason: people === 1 ? `החזר מלא על ${e.description}` : `החזר חלק 1/${people} על ${e.description}` };
        }
      }
      if (best) break;
    }
    if (best) out.push(best);
  }
  return out;
}

/** Recompute the suggestions: answered links (confirmed / rejected) stay, suggestions that no longer fit are dropped. */
export function suggestPaybacks(db: DB): number {
  const answered = new Set((db.prepare(`SELECT from_txn_id || '|' || to_txn_id FROM transaction_links WHERE status != 'suggested'`).pluck().all() as string[]));
  const suggestions = findPaybackCandidates(loadTransactions(db), answered);
  const keep = new Set(suggestions.map(s => `${s.inflowId}|${s.expenseId}`));
  const waiting = db.prepare(`SELECT id, from_txn_id || '|' || to_txn_id AS pair FROM transaction_links WHERE status = 'suggested'`).all() as { id: number; pair: string }[];
  const drop = db.prepare(`DELETE FROM transaction_links WHERE id = ?`);
  const insert = db.prepare(`INSERT OR IGNORE INTO transaction_links (from_txn_id, to_txn_id, type, amount, status)
    VALUES (?, ?, ?, ?, 'suggested')`);
  db.transaction(() => {
    for (const w of waiting) if (!keep.has(w.pair)) drop.run(w.id);
    for (const s of suggestions) insert.run(s.inflowId, s.expenseId, s.type, s.amount);
  })();
  return suggestions.length;
}
