/**
 * "How much can we spend a day" (כמה אפשר להוציא ביום): the most that can go out every day until the end of the
 * planning period without the bank balance dropping below the buffer on any day — counting only money that is known to
 * come in or go out (scheduled items, planned payments, the certain part of card statements) and the monthly
 * set-aside for the expected-events fund. Everyday purchases are what the number is for, so their estimate is left out.
 */
import type { DB } from '../db/connection.js';
import { addDays, daysBetween, loadTransactions, round, type Tx, type TxFilter } from './common.js';
import { upcomingCardCharges, type CardCharge } from './cards.js';
import { buildForecast, type Forecast } from './forecast.js';
import { spendBaseline } from './cashflow.js';
import { DAYS_PER_MONTH, seasonalPlan } from './seasonal.js';

export interface AllowanceFlow { date: string; amount: number; name: string }

export interface AllowanceInput {
  asOf: string;
  until: string;
  startBalance: number;
  buffer: number;
  /** known money in (+) / out (−) after today, until `until` */
  flows: AllowanceFlow[];
  /** set aside every day for the expected-events fund */
  reservePerDay?: number;
}

export interface AllowanceResult {
  /** may be ≤ 0: the known payments alone take the balance below the buffer */
  perDay: number;
  /** the day that limits the amount (often the day before income arrives) */
  bindingDate: string;
  /** days from today to the binding day, today included */
  bindingDays: number;
  /** days from today to `until`, today included */
  daysLeft: number;
  /** balance with only the known flows, at its lowest point and at the end */
  lowest: { date: string; balance: number };
  endBalance: number;
  /** below the buffer even without spending anything (≥ 0) */
  shortfall: number;
}

/** Pure: the largest steady daily spend that keeps every day's balance at or above the buffer. */
export function computeAllowance(input: AllowanceInput): AllowanceResult {
  const { asOf, until, buffer } = input;
  const byDate = new Map<string, number>();
  for (const f of input.flows) if (f.date > asOf && f.date <= until) byDate.set(f.date, (byDate.get(f.date) ?? 0) + f.amount);

  let balance = input.startBalance;
  let best = { perDay: Infinity, date: asOf, days: 1 };
  let lowest = { date: asOf, balance };
  for (let date = asOf, n = 1; date <= until; date = addDays(date, 1), n++) {
    balance += byDate.get(date) ?? 0;
    if (balance < lowest.balance) lowest = { date, balance };
    const perDay = (balance - buffer) / n;
    if (perDay < best.perDay) best = { perDay, date, days: n };
  }
  const reserve = input.reservePerDay ?? 0;
  return {
    perDay: round(best.perDay - reserve, 0),
    bindingDate: best.date,
    bindingDays: best.days,
    daysLeft: daysBetween(asOf, until) + 1,
    lowest: { date: lowest.date, balance: round(lowest.balance) },
    endBalance: round(balance),
    shortfall: round(Math.max(0, buffer - lowest.balance)),
  };
}

export interface DailyAllowance extends AllowanceResult {
  asOf: string;
  until: string;
  startBalance: number;
  buffer: number;
  /** known income still to come, and known payments still to go out, until `until` */
  incoming: number;
  outgoing: number;
  /** the expected-events fund: monthly set-aside and what of it falls in the days left */
  seasonal: { perMonth: number; reserve: number };
  /** typical everyday (variable) spend per day, from the last complete months */
  pace: number;
  status: 'ok' | 'tight' | 'none';
  /** the next known income after the binding day (to explain it) */
  nextIncome: { date: string; name: string; amount: number } | null;
  stale: boolean;
}

/** The certain part of a card statement: reported rows + installments + fixed and planned payments not reported yet. */
export function committedCardAmount(c: CardCharge): number {
  return Math.min(c.expectedAmount, c.knownAmount + c.projectedInstallments + c.projectedFixed + c.projectedPlanned);
}

export function buildAllowance(db: DB, opts: { asOf?: string; filter?: TxFilter; forecast?: Forecast; txs?: Tx[]; cardCharges?: CardCharge[] } = {}): DailyAllowance {
  const filter = opts.filter ?? {};
  const forecast = opts.forecast ?? buildForecast(db, { asOf: opts.asOf, memberId: filter.memberId });
  const asOf = forecast.asOf;
  const until = forecast.period.end;
  const txs = opts.txs ?? loadTransactions(db);
  const charges = opts.cardCharges ?? upcomingCardCharges(db, txs, asOf);
  const accounts = new Set(forecast.accounts.map(a => a.accountId));

  const flows: AllowanceFlow[] = [];
  for (const e of forecast.events) {
    if (e.source === 'dynamic' || !accounts.has(e.accountId) || e.date <= asOf || e.date > until) continue;
    // a reported / partly reported statement: only its certain part; a card with no statement yet stays an estimate
    const charge = e.kind === 'card_charge' && e.cardAccountId
      ? charges.find(c => c.cardAccountId === e.cardAccountId && c.chargeDate === e.date) : undefined;
    flows.push({ date: e.date, name: e.name, amount: charge ? -committedCardAmount(charge) : e.amount });
  }

  const seasonal = seasonalPlan(db, { asOf, withSuggestions: false });
  const reservePerDay = seasonal.perMonth / DAYS_PER_MONTH;
  const startBalance = forecast.accounts.reduce((s, a) => s + a.startBalance, 0);
  const result = computeAllowance({ asOf, until, startBalance, buffer: forecast.buffer, flows, reservePerDay });
  const pace = round(spendBaseline(db, filter, 6, asOf).dynamic / DAYS_PER_MONTH, 0);
  const income = flows.filter(f => f.amount > 0).sort((a, b) => a.date.localeCompare(b.date));
  const nextIncome = income.find(f => f.date > result.bindingDate) ?? null;

  return {
    ...result,
    asOf, until, startBalance: round(startBalance), buffer: forecast.buffer,
    incoming: round(income.reduce((s, f) => s + f.amount, 0)),
    outgoing: round(-flows.filter(f => f.amount < 0).reduce((s, f) => s + f.amount, 0)),
    seasonal: { perMonth: seasonal.perMonth, reserve: round(reservePerDay * result.daysLeft, 0) },
    pace,
    status: result.perDay <= 0 ? 'none' : pace > 0 && result.perDay < pace ? 'tight' : 'ok',
    nextIncome: nextIncome ? { date: nextIncome.date, name: nextIncome.name, amount: round(nextIncome.amount) } : null,
    stale: forecast.total.stale,
  };
}
