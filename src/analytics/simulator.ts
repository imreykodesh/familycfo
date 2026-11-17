/**
 * The simulator (/simulator): "what if we cut a category" and "which debt to repay first". Pure functions with no
 * imports, so the web UI runs the same code in the browser while a slider moves (web/src/pages/Simulator.tsx) and the
 * API runs it for the chat (GET /api/simulator/debts). Nothing here reads or writes the database; the inputs come
 * from GET /api/simulator/base (src/analytics/simulatorBase.ts).
 */

export interface SimDebt {
  id: number;
  name: string;
  /** what's left to repay today (₪, positive) */
  balance: number;
  /** yearly interest in percent (4.6 = 4.6%) */
  annualRate: number;
  /** the fixed monthly repayment (₪, positive) */
  monthlyPayment: number;
  /** linked to the CPI: the balance also grows by the assumed yearly CPI */
  cpiLinked: boolean;
}

export interface DebtAssumptions {
  /** assumed yearly CPI in percent, for CPI-linked debts */
  cpiAnnual: number;
  /** estimated early-repayment fee: percent of every shekel repaid beyond the fixed repayments (optional) */
  prepaymentFeePct?: number;
}

/** snowball: the smallest balance first. avalanche: the highest interest first (CPI-linked: interest + the CPI). */
export type DebtOrder = 'snowball' | 'avalanche';
/** baseline: every debt on its own fixed repayment, no extra, a closed debt's repayment isn't moved to another */
export type DebtMethod = 'baseline' | DebtOrder;

export interface DebtPlan {
  method: DebtMethod;
  /** months until the last debt is repaid; null = not within MAX_MONTHS (a repayment that doesn't cover the interest) */
  months: number | null;
  interest: number;
  /** what the CPI linkage adds (CPI-linked debts only) */
  indexation: number;
  fees: number;
  /** everything paid: the repayments + the extra (= today's balance + interest + indexation + fees) */
  totalPaid: number;
  /** the debts in the order they're repaid; month null = not within MAX_MONTHS */
  closing: { id: number; name: string; month: number | null }[];
  /** the total balance at the end of each month (index 0 = today) */
  balances: number[];
}

export interface DebtComparison {
  extra: number;
  baseline: DebtPlan;
  snowball: DebtPlan;
  avalanche: DebtPlan;
  /** per method: money (interest + indexation + fees) and months saved vs the baseline; months null when unknown */
  savings: Record<DebtOrder, { money: number; months: number | null }>;
  /** the cheaper of the two (by total cost; on a tie the one that ends sooner); null when there are no debts or both come out the same */
  best: DebtOrder | null;
}

export const MAX_MONTHS = 600;
const EPS = 0.005;
const r0 = (n: number) => Math.round(n);

const effectiveRate = (d: SimDebt, a: DebtAssumptions) => d.annualRate + (d.cpiLinked ? a.cpiAnnual : 0);

/** The order the extra money goes in. */
export function debtQueue(debts: SimDebt[], order: DebtOrder, a: DebtAssumptions): SimDebt[] {
  return [...debts].sort((x, y) => order === 'snowball'
    ? x.balance - y.balance || effectiveRate(y, a) - effectiveRate(x, a)
    : effectiveRate(y, a) - effectiveRate(x, a) || x.balance - y.balance);
}

/**
 * Month by month: 1. interest, 2. CPI linkage, 3. every debt's fixed repayment, 4. (snowball / avalanche) the extra
 * plus the repayments of debts already closed go to the first open debt in the queue, then the next.
 */
export function debtPlan(debts: SimDebt[], extra: number, method: DebtMethod, a: DebtAssumptions): DebtPlan {
  const rolls = method !== 'baseline';
  const queue = (rolls ? debtQueue(debts, method, a) : debts)
    .filter(d => d.balance > EPS)
    .map(d => ({ ...d, left: d.balance, closedAt: null as number | null }));
  const fee = Math.max(0, a.prepaymentFeePct ?? 0) / 100;
  const cpiMonthly = Math.pow(1 + a.cpiAnnual / 100, 1 / 12) - 1;
  const total = () => queue.reduce((s, d) => s + d.left, 0);

  let interest = 0, indexation = 0, fees = 0, paid = 0, month = 0;
  const balances = [r0(total())];
  while (queue.some(d => d.closedAt == null) && month < MAX_MONTHS) {
    month++;
    let pool = rolls ? Math.max(0, extra) : 0;
    for (const d of queue) {
      if (d.closedAt != null) { if (rolls) pool += d.monthlyPayment; continue; }
      const i = (d.left * d.annualRate) / 1200;
      const x = d.cpiLinked ? d.left * cpiMonthly : 0;
      interest += i;
      indexation += x;
      d.left += i + x;
      const pay = Math.min(Math.max(0, d.monthlyPayment), d.left);
      d.left -= pay;
      paid += pay;
      // the part of the repayment the debt didn't need in its last month rolls on too
      if (rolls) pool += Math.max(0, d.monthlyPayment) - pay;
    }
    for (const d of queue) {
      if (pool <= EPS) break;
      if (d.left <= EPS) continue;
      const principal = Math.min(d.left, pool / (1 + fee));
      d.left -= principal;
      fees += principal * fee;
      paid += principal * (1 + fee);
      pool -= principal * (1 + fee);
    }
    for (const d of queue) if (d.closedAt == null && d.left <= EPS) { d.left = 0; d.closedAt = month; }
    balances.push(r0(total()));
  }

  const open = queue.some(d => d.closedAt == null);
  return {
    method,
    months: open ? null : month,
    interest: r0(interest),
    indexation: r0(indexation),
    fees: r0(fees),
    totalPaid: r0(paid),
    closing: [...queue]
      .sort((x, y) => (x.closedAt ?? Infinity) - (y.closedAt ?? Infinity))
      .map(d => ({ id: d.id, name: d.name, month: d.closedAt })),
    balances,
  };
}

/** The baseline, snowball and avalanche side by side, with what each saves vs the baseline. */
export function compareDebtPlans(debts: SimDebt[], extra: number, a: DebtAssumptions): DebtComparison {
  const baseline = debtPlan(debts, 0, 'baseline', a);
  const snowball = debtPlan(debts, extra, 'snowball', a);
  const avalanche = debtPlan(debts, extra, 'avalanche', a);
  const cost = (p: DebtPlan) => p.interest + p.indexation + p.fees;
  const saving = (p: DebtPlan) => ({
    money: r0(cost(baseline) - cost(p)),
    months: baseline.months != null && p.months != null ? baseline.months - p.months : null,
  });
  const ends = (p: DebtPlan) => p.months ?? Infinity;
  const a1 = cost(avalanche), s1 = cost(snowball);
  const best: DebtOrder | null = !debts.some(d => d.balance > EPS) || (a1 === s1 && ends(avalanche) === ends(snowball)) ? null
    : a1 < s1 || (a1 === s1 && ends(avalanche) < ends(snowball)) ? 'avalanche' : 'snowball';
  return { extra: Math.max(0, extra), baseline, snowball, avalanche, savings: { snowball: saving(snowball), avalanche: saving(avalanche) }, best };
}

export interface SimGoal {
  id: number;
  name: string;
  balance: number;
  goalAmount: number;
  goalDate: string | null;
  /** how much goes into it every month today */
  monthlyTarget: number;
}

export interface GoalImpact {
  id: number;
  name: string;
  remaining: number;
  goalDate: string | null;
  /** months to the goal at today's monthly target; null = nothing goes into it */
  monthsNow: number | null;
  /** months to the goal if the whole cut goes into it as well */
  monthsWithCut: number | null;
  /** how many months sooner; null when monthsNow is unknown */
  monthsEarlier: number | null;
}

export interface CutImpact {
  monthly: number;
  yearly: number;
  goals: GoalImpact[];
}

/** What cutting `monthly` ₪ a month gives: per month, per year, and how much sooner each savings goal is reached. */
export function cutImpact(monthly: number, goals: SimGoal[]): CutImpact {
  const cut = Math.max(0, monthly);
  const months = (remaining: number, perMonth: number) => (remaining <= 0 ? 0 : perMonth > 0 ? Math.ceil(remaining / perMonth - 1e-9) : null);
  return {
    monthly: r0(cut),
    yearly: r0(cut * 12),
    goals: goals.map(g => {
      const remaining = Math.max(0, g.goalAmount - g.balance);
      const target = Math.max(0, g.monthlyTarget);
      const monthsNow = months(remaining, target);
      const monthsWithCut = months(remaining, target + cut);
      return {
        id: g.id, name: g.name, remaining: r0(remaining), goalDate: g.goalDate, monthsNow, monthsWithCut,
        monthsEarlier: monthsNow != null && monthsWithCut != null ? monthsNow - monthsWithCut : null,
      };
    }),
  };
}
