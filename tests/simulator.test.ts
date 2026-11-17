import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { compareDebtPlans, cutImpact, debtPlan, debtQueue, type SimDebt } from '../src/analytics/simulator.js';
import { simulatorBase } from '../src/analytics/simulatorBase.js';
import { simulatorRoutes } from '../src/server/routes/simulator.js';
import { addAccount, addTx, testDb } from './helpers.js';

const debt = (id: number, balance: number, annualRate: number, monthlyPayment: number, cpiLinked = false): SimDebt =>
  ({ id, name: `חוב ${id}`, balance, annualRate, monthlyPayment, cpiLinked });
const NO_CPI = { cpiAnnual: 0 };

describe('debt plans (computed by hand)', () => {
  it('the baseline repays each debt on its own payment; snowball rolls the extra and a closed debt\'s payment on', () => {
    const debts = [debt(1, 300, 0, 100), debt(2, 1000, 0, 100)];
    const baseline = debtPlan(debts, 100, 'baseline', NO_CPI);
    expect(baseline).toMatchObject({ months: 10, interest: 0, totalPaid: 1300 });
    expect(baseline.closing).toEqual([{ id: 1, name: 'חוב 1', month: 3 }, { id: 2, name: 'חוב 2', month: 10 }]);
    // month 1: 300→200→100 (extra), 1000→900. month 2: debt 1 closes, 900→800→700 (extra).
    // month 3: 700−100−(100 extra + 100 freed) = 400. month 4: 100. month 5: 0
    const snowball = debtPlan(debts, 100, 'snowball', NO_CPI);
    expect(snowball).toMatchObject({ months: 5, totalPaid: 1300 });
    expect(snowball.closing.map(c => c.month)).toEqual([2, 5]);
    expect(snowball.balances).toEqual([1300, 1000, 700, 400, 100, 0]);
  });

  it('interest, CPI linkage and the early-repayment fee', () => {
    // 1% a month on 1000 = 10, then the 1010 repayment closes it
    expect(debtPlan([debt(1, 1000, 12, 1010)], 0, 'baseline', NO_CPI)).toMatchObject({ months: 1, interest: 10, indexation: 0, totalPaid: 1010 });
    // a CPI of 1% a month (1.01^12 − 1 a year) adds 10 to a 0% linked loan
    const cpi = { cpiAnnual: (1.01 ** 12 - 1) * 100 };
    expect(debtPlan([debt(1, 1000, 0, 1010, true)], 0, 'baseline', cpi)).toMatchObject({ months: 1, interest: 0, indexation: 10 });
    // no fixed repayment: the baseline never ends; 505 extra with a 1% fee repays 500 a month and pays 5 in fees
    const noPayment = [debt(1, 1000, 0, 0)];
    const cmp = compareDebtPlans(noPayment, 505, { cpiAnnual: 0, prepaymentFeePct: 1 });
    expect(cmp.baseline.months).toBeNull();
    expect(cmp.snowball).toMatchObject({ months: 2, fees: 10, totalPaid: 1010 });
    expect(cmp.savings.snowball).toEqual({ money: -10, months: null });
  });

  it('avalanche goes to the highest interest first and costs less here', () => {
    const debts = [debt(1, 1000, 0, 100), debt(2, 5000, 12, 100), debt(3, 3000, 3, 100, true)];
    const a = { cpiAnnual: 2.5 };
    expect(debtQueue(debts, 'snowball', a).map(d => d.id)).toEqual([1, 3, 2]);
    // effective rates: 12, 3 + 2.5, 0
    expect(debtQueue(debts, 'avalanche', a).map(d => d.id)).toEqual([2, 3, 1]);
    const cmp = compareDebtPlans(debts, 500, a);
    expect(cmp.best).toBe('avalanche');
    expect(cmp.avalanche.interest + cmp.avalanche.indexation).toBeLessThan(cmp.snowball.interest + cmp.snowball.indexation);
    expect(cmp.savings.avalanche.money).toBeGreaterThan(cmp.savings.snowball.money);
    expect(cmp.savings.avalanche.months).toBeGreaterThan(0);
    // snowball closes the smallest first
    expect(cmp.snowball.closing[0].id).toBe(1);
    expect(compareDebtPlans([], 500, a)).toMatchObject({ best: null, baseline: { months: 0 } });
  });
});

describe('cut impact', () => {
  it('per month, per year and how much sooner each goal is reached', () => {
    const goals = [
      { id: 1, name: 'רכב', balance: 4000, goalAmount: 10000, goalDate: null, monthlyTarget: 500 },
      { id: 2, name: 'חופשה', balance: 0, goalAmount: 6000, goalDate: '2027-08-01', monthlyTarget: 0 },
      { id: 3, name: 'הושג', balance: 3000, goalAmount: 2000, goalDate: null, monthlyTarget: 100 },
    ];
    expect(cutImpact(250, goals)).toEqual({
      monthly: 250, yearly: 3000,
      goals: [
        { id: 1, name: 'רכב', remaining: 6000, goalDate: null, monthsNow: 12, monthsWithCut: 8, monthsEarlier: 4 },
        { id: 2, name: 'חופשה', remaining: 6000, goalDate: '2027-08-01', monthsNow: null, monthsWithCut: 24, monthsEarlier: null },
        { id: 3, name: 'הושג', remaining: 0, goalDate: null, monthsNow: 0, monthsWithCut: 0, monthsEarlier: 0 },
      ],
    });
  });
});

describe('simulator base and API', () => {
  function setup() {
    const db = testDb();
    addAccount(db, 'leumi:1', 'bank');
    const food = Number(db.prepare(`INSERT INTO categories (name) VALUES ('סופר')`).run().lastInsertRowid);
    const fun = Number(db.prepare(`INSERT INTO categories (name) VALUES ('בילויים')`).run().lastInsertRowid);
    for (const m of ['07', '08', '09', '10']) {
      addTx(db, { account: 'leumi:1', date: `2026-${m}-01`, description: 'משכורת', amount: 12000, kind: 'income' });
      addTx(db, { account: 'leumi:1', date: `2026-${m}-12`, description: 'סופר שכונתי', amount: -2000, kind: 'expense', categoryId: food });
      addTx(db, { account: 'leumi:1', date: `2026-${m}-20`, description: 'מסעדה', amount: m === '10' ? -900 : -300, kind: 'expense', categoryId: fun });
    }
    const loan = (name: string, rate: number | null, payment: number | null, index: string | null, balance: number | null) => {
      const id = Number(db.prepare(`INSERT INTO liabilities (name, type, interest_rate, monthly_payment, index_type) VALUES (?, 'loan', ?, ?, ?)`)
        .run(name, rate, payment, index).lastInsertRowid);
      if (balance != null) db.prepare(`INSERT INTO liability_snapshots (liability_id, date, balance) VALUES (?, '2026-11-01', ?)`).run(id, balance);
      return id;
    };
    const car = loan('הלוואת רכב', 6, 1200, 'cpi', 30000);
    loan('בלי יתרה', 5, 500, 'prime', null);
    // the repayment comes from the scheduled item linked to the loan
    const family = loan('הלוואה מהמשפחה', 0, null, null, 8000);
    db.prepare(`INSERT INTO scheduled_items (name, kind, amount, day_of_month, liability_id, status) VALUES ('החזר', 'loan', -400, 10, ?, 'confirmed')`).run(family);
    db.prepare(`INSERT INTO sinking_funds (name, balance, goal_amount, monthly_target) VALUES ('רכב חדש', 5000, 20000, 1000)`).run();
    const app = Fastify();
    simulatorRoutes(app, db);
    return { db, app, food, fun, car, family };
  }

  it('averages per category over the complete months, goals and loans that can be simulated', () => {
    const { db, food, fun, car, family } = setup();
    const base = simulatorBase(db, {}, '2026-11-17');
    expect(base.months).toMatchObject({ count: 4, from: '2026-07-01', to: '2026-10-31' });
    expect(base.categories).toEqual([
      { categoryId: food, name: 'סופר', parentName: null, average: 2000, fixed: 0 },
      { categoryId: fun, name: 'בילויים', parentName: null, average: 450, fixed: 0 },
    ]);
    expect(base.goals).toEqual([{ id: expect.any(Number), name: 'רכב חדש', balance: 5000, goalAmount: 20000, goalDate: null, monthlyTarget: 1000 }]);
    expect(base.debts).toEqual([
      expect.objectContaining({ id: family, balance: 8000, annualRate: 0, monthlyPayment: 400, cpiLinked: false }),
      expect.objectContaining({ id: car, balance: 30000, annualRate: 6, monthlyPayment: 1200, cpiLinked: true, balanceDate: '2026-11-01' }),
    ]);
    expect(base.skipped).toEqual([{ id: expect.any(Number), name: 'בלי יתרה', reason: 'חסרה יתרה לסילוק' }]);
  });

  it('GET /simulator/debts compares the methods for the chat', async () => {
    const { app } = setup();
    const res = (await app.inject({ method: 'GET', url: '/api/simulator/debts?extra=600&cpi=2' })).json();
    expect(res.assumptions).toEqual({ cpiAnnual: 2, prepaymentFeePct: 0 });
    expect(res.extra).toBe(600);
    // the family loan (0%, 8000 / 400) ends after 20 months on its own
    expect(res.baseline.closing.find((c: { name: string }) => c.name === 'הלוואה מהמשפחה').month).toBe(20);
    expect(res.baseline.balances).toBeUndefined();
    expect(res.snowball.months).toBeLessThan(res.baseline.months);
    expect(res.best).toBe('avalanche');
    expect((await app.inject({ method: 'GET', url: '/api/simulator/debts?extra=abc' })).statusCode).toBe(400);
  });
});
