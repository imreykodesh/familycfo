/**
 * The fund for expected events (קופה לאירועים צפויים): holidays by the Hebrew calendar, summer vacation, birthdays…
 * Big yearly expenses a monthly average never sees, because they move between Gregorian months. Each event has a
 * yearly date and an expected cost; the pot is a sinking fund (kind = 'seasonal'). The plan says how much to put aside
 * every month so every event is covered when it comes, and which past events still need "how much did it take?".
 */
import type { DB } from '../db/connection.js';
import { addDays, daysBetween, loadTransactions, spendOf, today, type Tx } from './common.js';
import { HEBREW_MONTH_NAMES, lastOccurrence, nextOccurrence, occurrences, type Calendar, type HebrewMonth } from './hebcal.js';

export const DAYS_PER_MONTH = 30.44;

export interface SeasonalEventRow {
  id: number; name: string; calendar: Calendar; month: string; day: number; amount: number; active: number;
  settled_through: string | null; notes: string | null; created_at: string | null;
}

export interface SeasonalEventPlan {
  id: number;
  name: string;
  calendar: Calendar;
  month: string;
  day: number;
  /** e.g. "15 בניסן" / "1.9" */
  dateLabel: string;
  amount: number;
  active: boolean;
  notes: string | null;
  nextDate: string;
  daysUntil: number;
  /** the pot already holds enough for this event and every earlier one */
  covered: boolean;
  /** a past occurrence the user hasn't said how much it took from the pot */
  pendingSettle: string | null;
  /** typical extra spend around this date in past years (null: no history) */
  suggested: number | null;
}

export interface SeasonalPlan {
  asOf: string;
  pot: { fundId: number | null; balance: number };
  /** how much to put aside every month so every event is covered in time */
  perMonth: number;
  events: SeasonalEventPlan[];
  next: SeasonalEventPlan | null;
  /** total of the events in the next 12 months minus what's in the pot */
  missing: number;
  /** common events not added yet, with an amount from history */
  suggestions: { key: string; name: string; calendar: Calendar; month: string; day: number; suggested: number | null }[];
}

/** The usual big events of an Israeli household's year. */
export const COMMON_EVENTS: { key: string; name: string; calendar: Calendar; month: HebrewMonth; day: number }[] = [
  { key: 'tishri', name: 'חגי תשרי', calendar: 'hebrew', month: 'Tishri', day: 1 },
  { key: 'hanukkah', name: 'חנוכה', calendar: 'hebrew', month: 'Kislev', day: 25 },
  { key: 'purim', name: 'פורים', calendar: 'hebrew', month: 'Adar', day: 14 },
  { key: 'pesach', name: 'פסח', calendar: 'hebrew', month: 'Nisan', day: 15 },
  { key: 'summer', name: 'חופש הגדול', calendar: 'hebrew', month: 'Av', day: 1 },
];

const HEB_DAY = ['', 'א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ז׳', 'ח׳', 'ט׳', 'י׳', 'י״א', 'י״ב', 'י״ג', 'י״ד', 'ט״ו', 'ט״ז', 'י״ז',
  'י״ח', 'י״ט', 'כ׳', 'כ״א', 'כ״ב', 'כ״ג', 'כ״ד', 'כ״ה', 'כ״ו', 'כ״ז', 'כ״ח', 'כ״ט', 'ל׳'];

export function dateLabel(calendar: Calendar, month: string, day: number): string {
  if (calendar === 'gregorian') return `${day}.${month}`;
  return `${HEB_DAY[day] ?? day} ב${HEBREW_MONTH_NAMES[month as HebrewMonth] ?? month}`;
}

const roundUp = (n: number, step: number) => Math.ceil(n / step - 1e-9) * step;

/**
 * The lowest steady monthly amount that covers every event by its date: sorted by date, event k needs the pot to hold
 * the total of events 1..k by then, so perMonth = max over k of (total_k − pot) / months until k (at least 1 month).
 */
export function monthlySetAside(events: { amount: number; daysUntil: number }[], pot: number): number {
  const sorted = [...events].sort((a, b) => a.daysUntil - b.daysUntil);
  let total = 0, need = 0;
  for (const e of sorted) {
    total += e.amount;
    need = Math.max(need, (total - pot) / Math.max(1, e.daysUntil / DAYS_PER_MONTH));
  }
  return need > 0 ? roundUp(need, 10) : 0;
}

/**
 * A usual day's spend: the mean without the busiest 10% of days (a one-off purchase shouldn't raise it, and days
 * without any purchase are real — a median would be ~0 for a household that shops twice a week).
 */
function typicalDay(days: number[]): number {
  if (!days.length) return 0;
  const kept = [...days].sort((a, b) => a - b).slice(0, Math.max(1, Math.ceil(days.length * 0.9)));
  return kept.reduce((s, x) => s + x, 0) / kept.length;
}

const WINDOW_BEFORE = 21;
const WINDOW_AFTER = 7;
const BASELINE_DAYS = 120;

/**
 * How much more than usual the household spent around this date in past years: variable (non-fixed) spend in the
 * 29 days around each past occurrence, minus 29 × a usual day's variable spend in the 120 days before (typicalDay).
 * Occurrences without 30 days of data before them are skipped. Null when there is no such occurrence.
 */
export function suggestFromHistory(txs: Tx[], calendar: Calendar, month: string, day: number, asOf: string): number | null {
  const variable = txs.filter(t => !t.fixed && t.kind === 'expense');
  if (!variable.length) return null;
  const earliest = variable.reduce((m, t) => (t.effectiveDate < m ? t.effectiveDate : m), variable[0].effectiveDate);
  const byDay = new Map<string, number>();
  for (const t of variable) byDay.set(t.effectiveDate, (byDay.get(t.effectiveDate) ?? 0) + spendOf(t));

  const extras: number[] = [];
  for (const date of occurrences(calendar, month, day, addDays(asOf, -3 * 366), addDays(asOf, -WINDOW_AFTER))) {
    const start = addDays(date, -WINDOW_BEFORE), end = addDays(date, WINDOW_AFTER);
    if (daysBetween(earliest, start) < 30) continue;
    let windowSpend = 0;
    for (let d = start; d <= end; d = addDays(d, 1)) windowSpend += byDay.get(d) ?? 0;
    const baseline: number[] = [];
    for (let d = addDays(start, -Math.min(BASELINE_DAYS, daysBetween(earliest, start))); d < start; d = addDays(d, 1)) baseline.push(byDay.get(d) ?? 0);
    const extra = windowSpend - typicalDay(baseline) * (WINDOW_BEFORE + WINDOW_AFTER + 1);
    extras.push(Math.max(0, extra));
  }
  if (!extras.length) return null;
  const avg = extras.reduce((s, x) => s + x, 0) / extras.length;
  return Math.round(avg / 50) * 50;
}

export function seasonalPot(db: DB): { fundId: number | null; balance: number } {
  const row = db.prepare(`SELECT id, balance FROM sinking_funds WHERE kind = 'seasonal' ORDER BY id LIMIT 1`).get() as { id: number; balance: number } | undefined;
  return { fundId: row?.id ?? null, balance: row?.balance ?? 0 };
}

/** The pot's fund, created the first time it's needed. */
export function ensureSeasonalPot(db: DB): number {
  const pot = seasonalPot(db);
  if (pot.fundId != null) return pot.fundId;
  let name = 'קופה לאירועים צפויים';
  if (db.prepare(`SELECT 1 FROM sinking_funds WHERE name = ?`).get(name)) name = `${name} (חגים)`;
  return Number(db.prepare(`INSERT INTO sinking_funds (name, monthly_target, balance, kind) VALUES (?, 0, 0, 'seasonal')`).run(name).lastInsertRowid);
}

export function listSeasonalEvents(db: DB): SeasonalEventRow[] {
  return db.prepare(`SELECT * FROM seasonal_events ORDER BY id`).all() as SeasonalEventRow[];
}

export function seasonalPlan(db: DB, opts: { asOf?: string; withSuggestions?: boolean; txs?: Tx[] } = {}): SeasonalPlan {
  const asOf = opts.asOf ?? today();
  const pot = seasonalPot(db);
  const rows = listSeasonalEvents(db);
  const withSuggestions = opts.withSuggestions ?? true;
  const txs = withSuggestions ? opts.txs ?? loadTransactions(db) : [];

  const events: SeasonalEventPlan[] = rows.map(r => {
    const nextDate = nextOccurrence(r.calendar, r.month, r.day, asOf);
    const last = lastOccurrence(r.calendar, r.month, r.day, addDays(asOf, -1));
    const createdOn = (r.created_at ?? '').slice(0, 10);
    const pendingSettle = r.active && last && (!r.settled_through || last > r.settled_through) && (!createdOn || last >= createdOn) ? last : null;
    return {
      id: r.id, name: r.name, calendar: r.calendar, month: r.month, day: r.day, dateLabel: dateLabel(r.calendar, r.month, r.day),
      amount: r.amount, active: !!r.active, notes: r.notes, nextDate, daysUntil: daysBetween(asOf, nextDate),
      covered: false, pendingSettle,
      suggested: withSuggestions ? suggestFromHistory(txs, r.calendar, r.month, r.day, asOf) : null,
    };
  }).sort((a, b) => a.daysUntil - b.daysUntil);

  const active = events.filter(e => e.active);
  let running = 0;
  for (const e of active) { running += e.amount; e.covered = pot.balance >= running; }
  const perMonth = monthlySetAside(active, pot.balance);
  const inYear = active.filter(e => e.daysUntil <= 365).reduce((s, e) => s + e.amount, 0);

  const taken = new Set(rows.map(r => `${r.calendar}|${r.month}|${r.day}`));
  const suggestions = withSuggestions ? COMMON_EVENTS
    .filter(c => !taken.has(`${c.calendar}|${c.month}|${c.day}`) && !rows.some(r => r.name === c.name))
    .map(c => ({ ...c, suggested: suggestFromHistory(txs, c.calendar, c.month, c.day, asOf) })) : [];

  return {
    asOf, pot, perMonth, events, next: active[0] ?? null,
    missing: Math.max(0, Math.round(inYear - pot.balance)), suggestions,
  };
}

/** "It took X from the pot": lower the pot and remember the occurrence as settled. */
export function settleSeasonalEvent(db: DB, id: number, date: string, spent: number): void {
  db.transaction(() => {
    const fundId = ensureSeasonalPot(db);
    if (spent > 0) db.prepare(`UPDATE sinking_funds SET balance = balance - ? WHERE id = ?`).run(spent, fundId);
    db.prepare(`UPDATE seasonal_events SET settled_through = ? WHERE id = ? AND (settled_through IS NULL OR settled_through < ?)`).run(date, id, date);
    // the question was answered: close its alert
    db.prepare(`UPDATE alerts SET dismissed_at = COALESCE(dismissed_at, CURRENT_TIMESTAMP) WHERE dedupe_key = ?`).run(`seasonal-settle:${id}:${date}`);
  })();
}
