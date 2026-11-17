import type { DB } from '../db/connection.js';
import { cyclesSince } from './cashflow.js';
import {
  cycleByKey, cycleStartDay, getSetting, incomeOf, loadTransactions, recentCycles, refundOf, round, spendOf, today, type Cycle, type Tx,
} from './common.js';

/**
 * Maaser (/maaser, settings.maaser_cfg): a percent of the income, month by month, vs the donations given (expenses in
 * the donation categories), with a running balance — positive = still to give, negative = given ahead.
 */
export interface MaaserConfig {
  enabled: boolean;
  /** percent of the income (10 = maaser, 20 = chomesh) */
  percent: number;
  /** net = the income that arrived in the accounts; gross = a fixed monthly amount the user enters */
  base: 'net' | 'gross';
  grossMonthly: number | null;
  /** categories that count as giving (a parent includes its sub-categories); null = the categories named "תרומה…" */
  donationCategoryIds: number[] | null;
  /** income categories that don't count (gifts, money from parents…) */
  excludeCategoryIds: number[];
  /** income rows whose description contains one of these don't count */
  excludePatterns: string[];
  /** the first month (cycle key YYYY-MM) counted; null = 12 months back */
  startMonth: string | null;
  /** carried in from before the first month: + still owed, − given ahead */
  openingBalance: number;
}

export const DEFAULT_MAASER: MaaserConfig = {
  enabled: false, percent: 10, base: 'net', grossMonthly: null, donationCategoryIds: null,
  excludeCategoryIds: [], excludePatterns: [], startMonth: null, openingBalance: 0,
};

export interface MaaserMonth {
  cycle: Cycle;
  /** the income counted (after the exclusions); gross: the monthly amount entered */
  income: number;
  /** income left out by the exclusions */
  excluded: number;
  required: number;
  given: number;
  /** running balance after this month: + still to give */
  balance: number;
  /** the current month, still going */
  partial: boolean;
}

export interface MaaserReport {
  config: MaaserConfig;
  donationCategories: { id: number; name: string }[];
  months: MaaserMonth[];
  totals: { required: number; given: number; remaining: number };
}

/** The saved settings merged over the defaults (anything malformed falls back to the default). */
export function maaserConfig(db: DB): MaaserConfig {
  let saved: Partial<MaaserConfig> = {};
  try { saved = JSON.parse(getSetting(db, 'maaser_cfg', '{}')) ?? {}; } catch { /* default */ }
  return { ...DEFAULT_MAASER, ...(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}) };
}

const isIntArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(x => Number.isInteger(x));

/** Validate a PUT body over the current settings. Returns the new settings or an error message. */
export function parseMaaserConfig(body: Record<string, unknown>, current: MaaserConfig): MaaserConfig | string {
  const next = { ...current };
  if (body.enabled !== undefined) next.enabled = body.enabled === true;
  if (body.percent !== undefined) {
    const p = Number(body.percent);
    if (!Number.isFinite(p) || p < 0 || p > 100) return 'אחוז לא תקין';
    next.percent = p;
  }
  if (body.base !== undefined) {
    if (body.base !== 'net' && body.base !== 'gross') return 'base must be net or gross';
    next.base = body.base;
  }
  if (body.grossMonthly !== undefined) {
    const g = body.grossMonthly == null || body.grossMonthly === '' ? null : Number(body.grossMonthly);
    if (g != null && (!Number.isFinite(g) || g < 0)) return 'סכום ברוטו לא תקין';
    next.grossMonthly = g;
  }
  if (body.donationCategoryIds !== undefined) {
    if (body.donationCategoryIds !== null && !isIntArray(body.donationCategoryIds)) return 'donationCategoryIds must be ids or null';
    next.donationCategoryIds = body.donationCategoryIds as number[] | null;
  }
  if (body.excludeCategoryIds !== undefined) {
    if (!isIntArray(body.excludeCategoryIds)) return 'excludeCategoryIds must be ids';
    next.excludeCategoryIds = body.excludeCategoryIds;
  }
  if (body.excludePatterns !== undefined) {
    const p = body.excludePatterns;
    if (!Array.isArray(p) || p.length > 30 || !p.every(x => typeof x === 'string')) return 'excludePatterns must be up to 30 texts';
    next.excludePatterns = p.map(x => x.trim()).filter(Boolean);
  }
  if (body.startMonth !== undefined) {
    if (body.startMonth !== null && body.startMonth !== '' && !/^\d{4}-\d{2}$/.test(String(body.startMonth))) return 'startMonth must be YYYY-MM';
    next.startMonth = body.startMonth ? String(body.startMonth) : null;
  }
  if (body.openingBalance !== undefined) {
    const o = Number(body.openingBalance ?? 0);
    if (!Number.isFinite(o)) return 'יתרת פתיחה לא תקינה';
    next.openingBalance = o;
  }
  return next;
}

export function saveMaaserConfig(db: DB, cfg: MaaserConfig): void {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('maaser_cfg', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(cfg));
}

/** The donation categories in use: the chosen ones, else the categories whose name starts with "תרומ" (not "…ומתנות"). */
export function donationCategories(db: DB, cfg: MaaserConfig): { id: number; name: string }[] {
  const all = db.prepare(`SELECT id, name FROM categories ORDER BY name`).all() as { id: number; name: string }[];
  if (cfg.donationCategoryIds) return all.filter(c => cfg.donationCategoryIds!.includes(c.id));
  return all.filter(c => c.name.startsWith('תרומ') && !c.name.includes('מתנות'));
}

/** Pure: one month of maaser from its rows. */
export function maaserMonth(txs: Tx[], cycle: Cycle, cfg: MaaserConfig, donationIds: Set<number>): Omit<MaaserMonth, 'balance' | 'partial'> {
  const inCycle = txs.filter(t => t.effectiveDate >= cycle.start && t.effectiveDate <= cycle.end);
  const patterns = cfg.excludePatterns.map(p => p.toLowerCase());
  const excludedRow = (t: Tx) => (t.categoryId != null && cfg.excludeCategoryIds.includes(t.categoryId))
    || (t.categoryParentId != null && cfg.excludeCategoryIds.includes(t.categoryParentId))
    || patterns.some(p => t.description.toLowerCase().includes(p));
  let income = 0, excluded = 0, given = 0;
  for (const t of inCycle) {
    const inc = incomeOf(t);
    if (inc > 0) { if (excludedRow(t)) excluded += inc; else income += inc; }
    if ((t.categoryId != null && donationIds.has(t.categoryId)) || (t.categoryParentId != null && donationIds.has(t.categoryParentId))) {
      given += spendOf(t) - refundOf(t);
    }
  }
  const base = cfg.base === 'gross' ? (cfg.grossMonthly ?? 0) : income;
  return { cycle, income: round(base), excluded: round(excluded), required: round((base * cfg.percent) / 100), given: round(given) };
}

export function maaserReport(db: DB, asOf = today()): MaaserReport {
  const cfg = maaserConfig(db);
  const startDay = cycleStartDay(db);
  const cats = donationCategories(db, cfg);
  const ids = new Set(cats.map(c => c.id));
  const count = cfg.startMonth ? Math.min(120, cyclesSince(cycleByKey(cfg.startMonth, startDay).start, asOf, startDay)) : 12;
  const cycles = recentCycles(asOf, count, startDay);
  const txs = loadTransactions(db);
  let balance = cfg.openingBalance;
  const months = cycles.map(c => {
    const m = maaserMonth(txs, c, cfg, ids);
    balance += m.required - m.given;
    return { ...m, balance: round(balance), partial: c.end >= asOf };
  });
  const required = round(months.reduce((s, m) => s + m.required, 0));
  const given = round(months.reduce((s, m) => s + m.given, 0));
  return { config: cfg, donationCategories: cats, months, totals: { required, given, remaining: round(balance) } };
}
