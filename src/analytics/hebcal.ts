/**
 * Hebrew-calendar dates without a library: Intl's hebrew calendar (full ICU ships with Node and Electron).
 * Month names are Intl's English ones: Tishri, Heshvan, Kislev, Tevet, Shevat, Adar (Adar I / Adar II in a leap year),
 * Nisan, Iyar, Sivan, Tamuz, Av, Elul.
 */
import { addDays } from './common.js';

export const HEBREW_MONTHS = ['Tishri', 'Heshvan', 'Kislev', 'Tevet', 'Shevat', 'Adar', 'Nisan', 'Iyar', 'Sivan', 'Tamuz', 'Av', 'Elul'] as const;
export type HebrewMonth = typeof HEBREW_MONTHS[number];

export const HEBREW_MONTH_NAMES: Record<HebrewMonth, string> = {
  Tishri: 'תשרי', Heshvan: 'חשוון', Kislev: 'כסלו', Tevet: 'טבת', Shevat: 'שבט', Adar: 'אדר',
  Nisan: 'ניסן', Iyar: 'אייר', Sivan: 'סיוון', Tamuz: 'תמוז', Av: 'אב', Elul: 'אלול',
};

export type Calendar = 'hebrew' | 'gregorian';

const fmt = new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const cache = new Map<string, { month: string; day: number }>();

/** The Hebrew month (Intl name: 'Adar II' in a leap year) and day of a YYYY-MM-DD date. */
export function hebrewParts(date: string): { month: string; day: number } {
  let parts = cache.get(date);
  if (!parts) {
    const p = fmt.formatToParts(new Date(`${date}T12:00:00Z`));
    parts = { month: p.find(x => x.type === 'month')?.value ?? '', day: Number(p.find(x => x.type === 'day')?.value ?? 0) };
    if (cache.size > 20_000) cache.clear();
    cache.set(date, parts);
  }
  return parts;
}

/** Does Intl's month name fall in the event's month? Adar = Adar of a plain year or Adar II (Purim) — never Adar I. */
function sameMonth(intlMonth: string, month: string): boolean {
  return intlMonth === month || (month === 'Adar' && intlMonth === 'Adar II');
}

export function isValidMonth(calendar: Calendar, month: string): boolean {
  if (calendar === 'hebrew') return (HEBREW_MONTHS as readonly string[]).includes(month);
  return /^(?:[1-9]|1[0-2])$/.test(month);
}

/**
 * The occurrences of a yearly date between from and to (inclusive), oldest first.
 * A day the month doesn't have that year (30 Heshvan in a short year, 31 Sep) falls on the month's last day.
 */
export function occurrences(calendar: Calendar, month: string, day: number, from: string, to: string): string[] {
  const out: string[] = [];
  if (calendar === 'gregorian') {
    const m0 = Number(month) - 1;
    for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
      const last = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
      const date = new Date(Date.UTC(y, m0, Math.min(day, last))).toISOString().slice(0, 10);
      if (date >= from && date <= to) out.push(date);
    }
    return out;
  }
  // walk day by day; inside the month remember the last day seen, so a missing 30th falls on the 29th
  let lastInMonth: string | null = null;
  let found = false;
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const p = hebrewParts(date);
    if (sameMonth(p.month, month)) {
      if (!found && p.day === day) { out.push(date); found = true; }
      lastInMonth = date;
    } else if (lastInMonth) {
      if (!found && hebrewParts(lastInMonth).day < day) out.push(lastInMonth);
      lastInMonth = null;
      found = false;
    }
  }
  return out;
}

/** The next occurrence on or after `from`. */
export function nextOccurrence(calendar: Calendar, month: string, day: number, from: string): string {
  return occurrences(calendar, month, day, from, addDays(from, 400))[0];
}

/** The latest occurrence on or before `to` (null if none in the year before). */
export function lastOccurrence(calendar: Calendar, month: string, day: number, to: string): string | null {
  return occurrences(calendar, month, day, addDays(to, -400), to).at(-1) ?? null;
}
