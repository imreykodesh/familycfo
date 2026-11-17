import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { simulatorBase } from '../../analytics/simulatorBase.js';
import { compareDebtPlans } from '../../analytics/simulator.js';
import { parseFilter } from './transactions.js';

/** A number from the query string, or the fallback; null when it's not a number or is out of range. */
function num(v: string | undefined, fallback: number, min: number, max: number): number | null {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

export function simulatorRoutes(app: FastifyInstance, db: DB): void {
  // the inputs of /simulator: averages per category, savings goals, loans. The screen runs the simulation itself.
  app.get('/api/simulator/base', async req => simulatorBase(db, parseFilter(req.query as Record<string, string | undefined>)));

  // the same debt comparison the screen shows, for the chat: ?extra=₪ a month &cpi=% a year &fee=% early-repayment fee
  app.get('/api/simulator/debts', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const base = simulatorBase(db, parseFilter(q));
    const extra = num(q.extra, 0, 0, 10_000_000);
    const cpi = num(q.cpi, base.assumptions.cpiAnnual, -20, 50);
    const fee = num(q.fee, 0, 0, 100);
    if (extra == null || cpi == null || fee == null) return reply.code(400).send({ error: 'extra, cpi and fee must be numbers' });
    const plans = compareDebtPlans(base.debts, extra, { cpiAnnual: cpi, prepaymentFeePct: fee });
    // the month-by-month balances are for the chart; the chat gets the totals
    const brief = ({ balances: _b, ...p }: typeof plans.baseline) => p;
    return {
      debts: base.debts, skipped: base.skipped, assumptions: { cpiAnnual: cpi, prepaymentFeePct: fee },
      ...plans, baseline: brief(plans.baseline), snowball: brief(plans.snowball), avalanche: brief(plans.avalanche),
    };
  });
}
