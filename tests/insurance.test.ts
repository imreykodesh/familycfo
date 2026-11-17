import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { insuranceInsights } from '../src/analytics/insurance.js';
import { buildRecommendations } from '../src/analytics/recommendations.js';
import { refreshRecurring } from '../src/analytics/recurring.js';
import { transactionRoutes } from '../src/server/routes/transactions.js';
import { addAccount, addTx, testDb } from './helpers.js';

const AS_OF = '2026-11-17';

function setup() {
  const db = testDb();
  addAccount(db, 'leumi:1', 'bank', 1);
  const fuel = Number(db.prepare(`INSERT INTO categories (name) VALUES ('דלק וחשמל')`).run().lastInsertRowid);
  for (const m of ['08', '09', '10', '11']) addTx(db, { account: 'leumi:1', date: `2026-${m}-02`, description: 'משכורת חברת אלפא', amount: 12000, kind: 'income' });
  // fuel until June, nothing since
  for (const m of ['03', '04', '05', '06']) addTx(db, { account: 'leumi:1', date: `2026-${m}-15`, description: 'פז אילת', amount: -300, kind: 'expense', categoryId: fuel });
  // nursing insurance: 100 → 120 a month during the year
  for (const [i, m] of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].entries()) {
    addTx(db, { account: 'leumi:1', date: `${m}-10`, description: 'הראל סיעודי', amount: i < 5 ? -100 : -120, kind: 'expense' });
  }
  const policy = db.prepare(`INSERT INTO insurance_policies (name, type, premium, premium_frequency, match_pattern, insured_member_id) VALUES (?, ?, ?, ?, ?, ?)`);
  policy.run('סיעודי הראל', 'nursing', 120, 'monthly', 'הראל סיעודי', 1);
  policy.run('דירה — הפניקס', 'home', 80, 'monthly', null, null);
  policy.run('מבנה — משכנתא', 'home', 45, 'monthly', null, null);
  policy.run('רכב מקיף', 'car', 3600, 'yearly', null, null);
  refreshRecurring(db, AS_OF);
  return db;
}

describe('insurance tips', () => {
  it('no disability cover with a salary, two home policies, nursing getting dearer, a car with no fuel for months', () => {
    const db = setup();
    const tips = insuranceInsights(db, AS_OF);
    const byKind = (k: string) => tips.find(t => t.key.startsWith(`insurance:${k}`));
    expect(byKind('no-disability:1')).toMatchObject({ title: expect.stringContaining('אין ביטוח אובדן כושר עבודה') });
    expect(byKind('double-home')).toMatchObject({ monthlySaving: 45 });
    expect(byKind('nursing-up')).toMatchObject({ title: expect.stringContaining('20%'), monthlySaving: 20 });
    expect(byKind('car-unused')).toMatchObject({ monthlySaving: 300 });
    // they show with the recommendations
    expect(buildRecommendations(db, AS_OF).filter(r => r.key.startsWith('insurance:')).length).toBeGreaterThanOrEqual(4);

    // a disability policy for the earner, and recent fuel, remove those two
    db.prepare(`INSERT INTO insurance_policies (name, type, insured_member_id) VALUES ('אכ"ע', 'disability', 1)`).run();
    addTx(db, { account: 'leumi:1', date: '2026-11-05', description: 'פז אילת', amount: -250, kind: 'expense' });
    const after = insuranceInsights(db, AS_OF).map(t => t.key.split(':')[1]);
    expect(after).not.toContain('no-disability');
    expect(after).not.toContain('car-unused');
  });

  it('the transactions list filters fixed / variable spend (the numbers on the overview open these)', async () => {
    const db = testDb();
    addAccount(db, 'leumi:1', 'bank');
    const rent = Number(db.prepare(`INSERT INTO categories (name, default_fixed) VALUES ('שכר דירה', 1)`).run().lastInsertRowid);
    addTx(db, { account: 'leumi:1', date: '2026-11-03', description: 'שכר דירה', amount: -5000, kind: 'expense', categoryId: rent });
    addTx(db, { account: 'leumi:1', date: '2026-11-04', description: 'סופר', amount: -400, kind: 'expense' });
    addTx(db, { account: 'leumi:1', date: '2026-11-05', description: 'משכורת', amount: 9000, kind: 'income' });
    const app = Fastify();
    transactionRoutes(app, db);
    const get = async (q: string) => (await app.inject({ method: 'GET', url: `/api/transactions?cycle=2026-11${q}` })).json();
    expect((await get('&fixed=1')).rows.map((r: { description: string }) => r.description)).toEqual(['שכר דירה']);
    expect((await get('&fixed=0')).rows.map((r: { description: string }) => r.description)).toEqual(['סופר']);
    expect((await get('&kind=expense,refund')).totals.spend).toBe(5400);
  });
});
