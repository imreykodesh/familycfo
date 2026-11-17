import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { maaserReport } from '../src/analytics/maaser.js';
import { maaserRoutes } from '../src/server/routes/maaser.js';
import { addAccount, addTx, testDb } from './helpers.js';

const AS_OF = '2026-11-17';

function setup() {
  const db = testDb();
  addAccount(db, 'leumi:1', 'bank');
  const cat = (name: string, kind = 'expense', parent: number | null = null) =>
    Number(db.prepare(`INSERT INTO categories (name, kind, parent_id) VALUES (?, ?, ?)`).run(name, kind, parent).lastInsertRowid);
  const parent = cat('תרומות ומתנות');
  const donation = cat('תרומה', 'expense', parent);
  const gifts = cat('מתנות ואירועים', 'expense', parent);
  const fromParents = cat('עזרה מההורים', 'income');
  for (const m of ['09', '10', '11']) {
    addTx(db, { account: 'leumi:1', date: `2026-${m}-02`, description: 'משכורת', amount: 10000, kind: 'income' });
    addTx(db, { account: 'leumi:1', date: `2026-${m}-10`, description: 'ישיבת אור', amount: m === '10' ? -1500 : -600, kind: 'expense', categoryId: donation });
    addTx(db, { account: 'leumi:1', date: `2026-${m}-12`, description: 'מתנה לחתונה', amount: -400, kind: 'expense', categoryId: gifts });
  }
  addTx(db, { account: 'leumi:1', date: '2026-10-05', description: 'העברה מאבא', amount: 2000, kind: 'income', categoryId: fromParents });
  addTx(db, { account: 'leumi:1', date: '2026-10-06', description: 'החזר מס הכנסה', amount: 1000, kind: 'income' });
  const app = Fastify();
  maaserRoutes(app, db);
  return { db, app, donation, gifts, fromParents };
}

describe('maaser', () => {
  it('10% of the net income vs the donation category, with a running balance', () => {
    const { db } = setup();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('maaser_cfg', ?)`).run(JSON.stringify({ enabled: true, startMonth: '2026-09' }));
    const r = maaserReport(db, AS_OF);
    expect(r.donationCategories.map(c => c.name)).toEqual(['תרומה']); // the default: not the gifts
    expect(r.months.map(m => [m.cycle.key, m.income, m.required, m.given, m.balance, m.partial])).toEqual([
      ['2026-09', 10000, 1000, 600, 400, false],
      ['2026-10', 13000, 1300, 1500, 200, false],
      ['2026-11', 10000, 1000, 600, 600, true],
    ]);
    expect(r.totals).toEqual({ required: 3300, given: 2700, remaining: 600 });
  });

  it('excluded incomes, gross base, opening balance and chosen categories via the API', async () => {
    const { app, fromParents, donation, gifts } = setup();
    let r = (await app.inject({ method: 'PUT', url: '/api/maaser/config', payload: {
      enabled: true, startMonth: '2026-10', excludeCategoryIds: [fromParents], excludePatterns: ['החזר מס'], openingBalance: 250,
    } })).json();
    expect(r.months[0]).toMatchObject({ income: 10000, excluded: 3000, required: 1000, given: 1500, balance: -250 });
    // gross 15,000 a month at 20%, gifts count as giving too
    r = (await app.inject({ method: 'PUT', url: '/api/maaser/config', payload: { base: 'gross', grossMonthly: 15000, percent: 20, donationCategoryIds: [donation, gifts] } })).json();
    expect(r.months[0]).toMatchObject({ income: 15000, required: 3000, given: 1900 });
    expect(r.totals.remaining).toBe(250 + 3000 - 1900 + 3000 - 1000);
    expect((await app.inject({ method: 'PUT', url: '/api/maaser/config', payload: { percent: 120 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/maaser/config', payload: { startMonth: '10/2026' } })).statusCode).toBe(400);
  });
});
