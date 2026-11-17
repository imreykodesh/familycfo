import type { DB } from '../db/connection.js';
import { round, today, type TxFilter } from './common.js';
import { spendBaseline } from './cashflow.js';
import type { SimDebt, SimGoal } from './simulator.js';

export interface SimCategory {
  categoryId: number;
  name: string;
  parentName: string | null;
  /** average monthly spend over the complete months (₪) */
  average: number;
  /** the part of the average that's fixed (standing orders, subscriptions) */
  fixed: number;
}

export interface SimulatorBase {
  /** the complete months the averages are taken from */
  months: { count: number; from: string | null; to: string | null };
  categories: SimCategory[];
  goals: SimGoal[];
  debts: (SimDebt & { balanceDate: string; indexType: string | null })[];
  /** loans that can't be simulated, and why */
  skipped: { id: number; name: string; reason: string }[];
  assumptions: { cpiAnnual: number };
}

/** Assumed yearly CPI (%) for CPI-linked loans; the user can change it on the screen. */
export const DEFAULT_CPI = 2.5;

/**
 * The inputs of the simulator: the average monthly spend per category over the last complete months (the same
 * months as `spendBaseline`), the savings goals (general funds with a goal), and the loans with their latest balance.
 * A loan's monthly repayment is `liabilities.monthly_payment`, else the scheduled item linked to it.
 */
export function simulatorBase(db: DB, filter: TxFilter = {}, asOf = today()): SimulatorBase {
  const { history } = spendBaseline(db, filter, 6, asOf);
  const byCat = new Map<number, SimCategory & { total: number; fixedTotal: number }>();
  for (const h of history) {
    for (const c of h.byCategory) {
      if (c.categoryId == null || c.spend <= 0) continue;
      const cur = byCat.get(c.categoryId) ?? { categoryId: c.categoryId, name: c.name, parentName: c.parentName, average: 0, fixed: 0, total: 0, fixedTotal: 0 };
      cur.total += c.spend;
      cur.fixedTotal += c.fixed;
      byCat.set(c.categoryId, cur);
    }
  }
  const n = history.length || 1;
  const categories = [...byCat.values()]
    .map(({ total, fixedTotal, ...c }) => ({ ...c, average: round(total / n, 0), fixed: round(Math.max(0, fixedTotal) / n, 0) }))
    .filter(c => c.average > 0)
    .sort((a, b) => b.average - a.average);

  const goals = (db.prepare(`SELECT id, name, balance, goal_amount, goal_date, monthly_target FROM sinking_funds
    WHERE kind = 'general' AND goal_amount > 0 ORDER BY name`).all() as {
      id: number; name: string; balance: number; goal_amount: number; goal_date: string | null; monthly_target: number;
    }[]).map(g => ({ id: g.id, name: g.name, balance: g.balance, goalAmount: g.goal_amount, goalDate: g.goal_date, monthlyTarget: g.monthly_target }));

  const loans = db.prepare(`
    SELECT l.id, l.name, l.interest_rate, l.index_type, l.monthly_payment, l.owner_member_id, s.balance, s.date AS balance_date,
      (SELECT ABS(amount) FROM scheduled_items WHERE liability_id = l.id AND status != 'dismissed' ORDER BY id LIMIT 1) AS scheduled_payment
    FROM liabilities l
    LEFT JOIN liability_snapshots s ON s.id = (SELECT id FROM liability_snapshots WHERE liability_id = l.id ORDER BY date DESC, id DESC LIMIT 1)
    WHERE l.archived = 0 ORDER BY l.name
  `).all() as {
    id: number; name: string; interest_rate: number | null; index_type: string | null; monthly_payment: number | null;
    owner_member_id: number | null; balance: number | null; balance_date: string | null; scheduled_payment: number | null;
  }[];
  const debts: SimulatorBase['debts'] = [];
  const skipped: SimulatorBase['skipped'] = [];
  for (const l of loans) {
    // a member's view: their own loans and the shared ones
    if (filter.memberId != null && l.owner_member_id != null && l.owner_member_id !== filter.memberId) continue;
    const payment = Math.abs(l.monthly_payment || l.scheduled_payment || 0);
    const reason = l.balance == null ? 'חסרה יתרה לסילוק' : l.balance <= 0 ? 'היתרה אפס' : l.interest_rate == null ? 'חסרה ריבית'
      : payment <= 0 ? 'חסר החזר חודשי' : null;
    if (reason) { skipped.push({ id: l.id, name: l.name, reason }); continue; }
    debts.push({
      id: l.id, name: l.name, balance: Math.abs(l.balance!), annualRate: l.interest_rate!, monthlyPayment: payment,
      cpiLinked: l.index_type === 'cpi', indexType: l.index_type, balanceDate: l.balance_date!,
    });
  }

  return {
    months: { count: history.length, from: history[0]?.cycle.start ?? null, to: history.at(-1)?.cycle.end ?? null },
    categories, goals, debts, skipped, assumptions: { cpiAnnual: DEFAULT_CPI },
  };
}
