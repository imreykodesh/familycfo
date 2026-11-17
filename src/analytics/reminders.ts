import type { DB } from '../db/connection.js';
import { addDays, dayInMonth, today } from './common.js';

/**
 * Reminders (/reminders, migration 22). Manual ones: a text, a date and time (Israel local), once / monthly / yearly.
 * Automatic ones from dates the app already has: an insurance policy ending / renewing (30 days before), a loan
 * ending (30 days before), a study fund becoming liquid (30 days before), a planned expense (3 days before).
 * `fireDueReminders` (every minute in the server, and in the pipeline) turns what's due into alerts — with a screen
 * to open — so the desktop app shows them as system notifications (takeAlertsToNotify).
 */

export type Repeat = 'once' | 'monthly' | 'yearly';

export interface Reminder {
  id: number;
  text: string;
  startAt: string;
  repeat: Repeat;
  href: string | null;
  /** the next time it will remind; null = no more (a one-time reminder that fired, or stopped) */
  nextAt: string | null;
  lastFiredAt: string | null;
  doneAt: string | null;
}

export interface AutoReminder {
  key: string;
  kind: 'insurance' | 'loan' | 'study_fund' | 'planned';
  title: string;
  message: string;
  href: string;
  /** the date it's about (end / liquidity / purchase) */
  date: string;
  /** the day it reminds (date − lead days) */
  remindOn: string;
}

/** 2026-12-08 → 08.12.2026 (how dates read in the texts) */
const dmy = (d: string) => d.slice(0, 10).split('-').reverse().join('.');

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const isReminderTime = (v: unknown): v is string => typeof v === 'string' && AT.test(v);

/** Now in Israel, YYYY-MM-DDTHH:MM. */
export function nowLocal(d = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(d).replace(' ', 'T');
}

/** The k-th occurrence of a reminder (k = 0 is start_at); months / years keep the start's day, clamped to the month. */
export function occurrence(start: string, repeat: Repeat, k: number): string {
  if (repeat === 'once' || k === 0) return start;
  const y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7)) - 1, d = Number(start.slice(8, 10));
  const months = repeat === 'monthly' ? m + k : m + 12 * k;
  return `${dayInMonth(y + Math.floor(months / 12), ((months % 12) + 12) % 12, d)}${start.slice(10)}`;
}

/** The latest occurrence at or before `now` (null = not yet), and the first one after it. */
export function occurrencesAround(start: string, repeat: Repeat, now: string): { last: string | null; next: string | null } {
  if (start > now) return { last: null, next: start };
  if (repeat === 'once') return { last: start, next: null };
  let k = 0;
  while (k < 2400 && occurrence(start, repeat, k + 1) <= now) k++;
  return { last: occurrence(start, repeat, k), next: occurrence(start, repeat, k + 1) };
}

interface Raw { id: number; text: string; start_at: string; repeat: Repeat; href: string | null; last_fired_at: string | null; done_at: string | null }

export function listReminders(db: DB, now = nowLocal()): Reminder[] {
  const rows = db.prepare(`SELECT * FROM reminders ORDER BY done_at IS NOT NULL, start_at`).all() as Raw[];
  return rows.map(r => {
    const { last, next } = occurrencesAround(r.start_at, r.repeat, now);
    // a past occurrence that didn't fire yet is still the next thing to remind
    const pending = last != null && (r.last_fired_at == null || last > r.last_fired_at) ? last : null;
    return {
      id: r.id, text: r.text, startAt: r.start_at, repeat: r.repeat, href: r.href,
      nextAt: r.done_at ? null : pending ?? next, lastFiredAt: r.last_fired_at, doneAt: r.done_at,
    };
  }).sort((a, b) => (a.nextAt ?? '9999').localeCompare(b.nextAt ?? '9999'));
}

const LEAD_DAYS = { insurance: 30, loan: 30, study_fund: 30, planned: 3 } as const;

/** Automatic reminders whose date is from today up to `horizon` days ahead (the screen shows them; firing uses remindOn). */
export function autoReminders(db: DB, asOf = today(), horizon = 120): AutoReminder[] {
  const until = addDays(asOf, horizon);
  const out: AutoReminder[] = [];
  const add = (r: Omit<AutoReminder, 'remindOn'>) => out.push({ ...r, remindOn: addDays(r.date, -LEAD_DAYS[r.kind]) });

  for (const p of db.prepare(`SELECT id, name, insurer, end_date FROM insurance_policies WHERE archived = 0 AND end_date BETWEEN ? AND ?`)
    .all(asOf, until) as { id: number; name: string; insurer: string | null; end_date: string }[]) {
    add({ key: `insurance:${p.id}:${p.end_date}`, kind: 'insurance', date: p.end_date, href: '/insurance',
      title: `הביטוח „${p.name}" מסתיים או מתחדש ב-${dmy(p.end_date)}`,
      message: `${p.insurer ? `${p.insurer}. ` : ''}זה הזמן לבדוק את המחיר, להשוות הצעות, או לבטל אם כבר לא צריך.` });
  }
  for (const l of db.prepare(`SELECT id, name, lender, end_date FROM liabilities WHERE archived = 0 AND end_date BETWEEN ? AND ?`)
    .all(asOf, until) as { id: number; name: string; lender: string | null; end_date: string }[]) {
    add({ key: `loan:${l.id}:${l.end_date}`, kind: 'loan', date: l.end_date, href: '/loans',
      title: `ההלוואה „${l.name}" מסתיימת ב-${dmy(l.end_date)}`,
      message: 'כדאי לוודא שהחיוב נפסק אחרי התשלום האחרון, ולהחליט מה לעשות עם הכסף שמתפנה כל חודש.' });
  }
  for (const a of db.prepare(`SELECT id, name, provider, liquidity_date FROM assets WHERE archived = 0 AND type = 'keren_hishtalmut' AND liquidity_date BETWEEN ? AND ?`)
    .all(asOf, until) as { id: number; name: string; provider: string | null; liquidity_date: string }[]) {
    add({ key: `study:${a.id}:${a.liquidity_date}`, kind: 'study_fund', date: a.liquidity_date, href: '/pension',
      title: `קרן ההשתלמות „${a.name}" נעשית נזילה ב-${dmy(a.liquidity_date)}`,
      message: `${a.provider ? `${a.provider}. ` : ''}אפשר למשוך בלי מס, או להשאיר אותה לחיסכון ולבדוק את דמי הניהול.` });
  }
  for (const p of db.prepare(`SELECT id, description, amount, date FROM planned_items WHERE status = 'planned' AND date BETWEEN ? AND ?`)
    .all(asOf, until) as { id: number; description: string; amount: number; date: string }[]) {
    add({ key: `planned:${p.id}:${p.date}`, kind: 'planned', date: p.date, href: '/fixed#planned',
      title: `הוצאה מתוכננת ב-${dmy(p.date)}: ${p.description}`,
      message: `₪${Math.round(p.amount).toLocaleString('en-US')}. היא כבר בתחזית ובתקציב; אם התוכניות השתנו, אפשר לדחות או לבטל.` });
  }
  return out.sort((a, b) => a.remindOn.localeCompare(b.remindOn));
}

/** Turn what's due into alerts (a manual reminder once per occurrence; an automatic one once per date). Returns how many. */
export function fireDueReminders(db: DB, now = nowLocal()): number {
  const insert = db.prepare(`INSERT OR IGNORE INTO alerts (type, severity, dedupe_key, title, message, href)
    VALUES (?, 'info', ?, ?, ?, ?)`);
  let added = 0;
  db.transaction(() => {
    for (const r of db.prepare(`SELECT * FROM reminders WHERE done_at IS NULL`).all() as Raw[]) {
      const { last, next } = occurrencesAround(r.start_at, r.repeat, now);
      if (last == null || (r.last_fired_at != null && last <= r.last_fired_at)) continue;
      added += insert.run('reminder', `reminder:${r.id}:${last}`, r.text,
        next ? `תזכורת ${r.repeat === 'monthly' ? 'חודשית' : 'שנתית'}. הבאה: ${dmy(next)} ${next.slice(11)}.` : 'תזכורת.', r.href).changes;
      db.prepare(`UPDATE reminders SET last_fired_at = ?, done_at = ? WHERE id = ?`).run(last, r.repeat === 'once' ? now : null, r.id);
    }
    const day = now.slice(0, 10);
    for (const a of autoReminders(db, day, 40).filter(a => a.remindOn <= day)) {
      added += insert.run('reminder_auto', `auto:${a.key}`, a.title, a.message, a.href).changes;
    }
  })();
  return added;
}
