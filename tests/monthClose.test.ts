import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { monthCloseRoutes } from '../src/server/routes/monthClose.js';
import { monthCloseState, monthReport, lastEndedCycle } from '../src/analytics/monthClose.js';
import { addAccount, addTx, testDb } from './helpers.js';

function setup() {
  const db = testDb();
  addAccount(db, 'leumi:1', 'bank');
  db.prepare(`UPDATE accounts SET last_scraped_at = '2026-11-16T08:00:00Z'`).run();
  const food = Number(db.prepare(`INSERT INTO categories (name) VALUES ('סופר')`).run().lastInsertRowid);
  // salary every month; the gym standing order stops after September
  for (const m of ['07', '08', '09', '10']) {
    addTx(db, { account: 'leumi:1', date: `2026-${m}-01`, description: 'משכורת', amount: 10000, kind: 'income' });
    addTx(db, { account: 'leumi:1', date: `2026-${m}-12`, description: 'סופר שכונתי', amount: -2000, kind: 'expense', categoryId: food });
    if (m !== '10') addTx(db, { account: 'leumi:1', date: `2026-${m}-05`, description: 'מכון כושר', amount: -250, kind: 'expense', categoryId: food });
  }
  addTx(db, { account: 'leumi:1', date: '2026-10-28', description: 'חנות לא ידועה', amount: -300, kind: 'expense' });
  const gym = Number(db.prepare(`INSERT INTO scheduled_items (name, kind, amount, day_of_month, bank_account_id, match_pattern, status)
    VALUES ('מכון כושר', 'fixed_expense', -250, 5, 'leumi:1', 'מכון כושר', 'confirmed')`).run().lastInsertRowid);
  const app = Fastify();
  monthCloseRoutes(app, db);
  return { db, app, gym };
}

describe('month close', () => {
  it('defaults to the last month that ended', () => {
    expect(lastEndedCycle('2026-11-17', 1)).toMatchObject({ key: '2026-10', start: '2026-10-01', end: '2026-10-31' });
    expect(lastEndedCycle('2026-11-17', 10)).toMatchObject({ key: '2026-10', start: '2026-10-10', end: '2026-11-09' });
  });

  it('lists what to check: accounts, uncategorized rows and a fixed item that did not show up', () => {
    const { db, gym } = setup();
    const s = monthCloseState(db, '2026-10', '2026-11-17');
    const byId = new Map(s.checks.map(c => [c.id, c]));
    expect(byId.get('account:leumi:1')).toMatchObject({ status: 'ok' });
    expect(byId.get('uncategorized')).toMatchObject({ status: 'warn', title: '1 הוצאות בלי קטגוריה', href: '/transactions?cycle=2026-10&review=1' });
    expect(byId.get('duplicates')).toMatchObject({ status: 'ok' });
    expect(byId.get(`fixed:${gym}`)).toMatchObject({ status: 'ask', answer: null });
    expect(s.todo).toBe(2);
    // September's gym charge arrived
    expect(monthCloseState(db, '2026-09', '2026-11-17').checks.some(c => c.kind === 'fixed')).toBe(false);
  });

  it('"ended" ends the fixed item from that month and the report shows the money freed', async () => {
    const { db, app, gym } = setup();
    const res = await app.inject({ method: 'PUT', url: '/api/month-close/2026-10/checks', payload: { checkId: `fixed:${gym}`, answer: 'ended' } });
    expect(res.json().checks.find((c: { id: string }) => c.id === `fixed:${gym}`)).toMatchObject({ status: 'ok', answer: 'ended' });
    expect(db.prepare(`SELECT end_date FROM scheduled_items WHERE id = ?`).pluck().get(gym)).toBe('2026-09-30');
    const report = monthReport(db, '2026-10', '2026-11-17');
    expect(report).toMatchObject({ income: 10000, spend: 2300, freedMonthly: 250, ended: [{ name: 'מכון כושר', amount: 250 }] });
    expect(report.average.months).toBeGreaterThan(0);
    expect(report.categories[0]).toMatchObject({ name: 'סופר', spend: 2000 });
    // changing the answer back reopens the item
    await app.inject({ method: 'PUT', url: '/api/month-close/2026-10/checks', payload: { checkId: `fixed:${gym}`, answer: 'later' } });
    expect(db.prepare(`SELECT end_date FROM scheduled_items WHERE id = ?`).pluck().get(gym)).toBeNull();
  });

  it('approves a warning, closes the month and notices a change after it', async () => {
    const { db, app } = setup();
    await app.inject({ method: 'PUT', url: '/api/month-close/2026-10/checks', payload: { checkId: 'uncategorized', answer: 'ok' } });
    expect(monthCloseState(db, '2026-10', '2026-11-17').checks.find(c => c.id === 'uncategorized')).toMatchObject({ status: 'ok', approved: true });
    expect((await app.inject({ method: 'POST', url: '/api/month-close/2026-10' })).json().closed).toMatchObject({ changed: false });
    addTx(db, { account: 'leumi:1', date: '2026-10-20', description: 'עוד קנייה', amount: -80, kind: 'expense' });
    expect(monthCloseState(db, '2026-10', '2026-11-17').closed).toMatchObject({ changed: true });
    expect((await app.inject({ method: 'PUT', url: '/api/month-close/2026-10/checks', payload: { checkId: 'x', answer: 'maybe' } })).statusCode).toBe(400);
    await app.inject({ method: 'DELETE', url: '/api/month-close/2026-10' });
    expect(monthCloseState(db, '2026-10', '2026-11-17').closed).toBeNull();
  });
});
