import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { healthReport, setIgnored } from '../src/analytics/health.js';
import { healthRoutes } from '../src/server/routes/health.js';
import { transactionRoutes } from '../src/server/routes/transactions.js';
import { addAccount, addBalance, addTx, testDb } from './helpers.js';

const AS_OF = '2026-11-17';

function setup() {
  const db = testDb();
  addAccount(db, 'leumi:1', 'bank');
  addAccount(db, 'max:1', 'card', null); // no owner, no bills: its paying account can't be detected
  addBalance(db, 'leumi:1', 5000, '2026-11-10T08:00:00Z');
  const food = Number(db.prepare(`INSERT INTO categories (name) VALUES ('סופר')`).run().lastInsertRowid);
  // a busy bank account with August missing
  for (const m of ['06', '07', '09', '10', '11']) {
    for (let d = 1; d <= 5; d++) addTx(db, { account: 'leumi:1', date: `2026-${m}-0${d}`, description: `חנות ${'אבגדה'[d - 1]}`, amount: -100 - d * 7, kind: 'expense', categoryId: food });
  }
  // categorized by hand 3 times to the same category
  for (const d of ['2026-09-20', '2026-10-20', '2026-11-12']) {
    const id = addTx(db, { account: 'leumi:1', date: d, description: 'מאפיית השכונה', amount: -60, kind: 'expense', categoryId: food });
    db.prepare(`UPDATE transactions SET category_source = 'manual' WHERE id = ?`).run(id);
  }
  // a possible duplicate and an uncategorized expense
  addTx(db, { account: 'leumi:1', date: '2026-10-21', description: 'חשמל', amount: -400, kind: 'expense', categoryId: food });
  addTx(db, { account: 'leumi:1', date: '2026-10-22', description: 'חשמל', amount: -400, kind: 'expense', categoryId: food });
  addTx(db, { account: 'leumi:1', date: '2026-10-25', description: 'חנות לא ידועה', amount: -900, kind: 'expense' });
  // a Bit payback waiting for a yes / no
  const dinner = addTx(db, { account: 'leumi:1', date: '2026-11-02', description: 'מסעדה', amount: -300, kind: 'expense', categoryId: food });
  const bit = addTx(db, { account: 'leumi:1', date: '2026-11-03', description: 'ביט מדנה', amount: 150, kind: 'income' });
  const link = Number(db.prepare(`INSERT INTO transaction_links (from_txn_id, to_txn_id, type, amount) VALUES (?, ?, 'payback', 150)`).run(bit, dinner).lastInsertRowid);
  db.prepare(`INSERT INTO planned_items (description, amount, date, account_id) VALUES ('מקרר', 4000, '2026-10-01', 'leumi:1')`).run();
  // two failed scrapes in a row after a success
  const run = db.prepare(`INSERT INTO scrape_runs (company, started_at, success, error_type, error_message) VALUES ('leumi', ?, ?, ?, ?)`);
  run.run('2026-11-10T07:00:00Z', 1, null, null);
  run.run('2026-11-11T07:00:00Z', 0, 'INVALID_PASSWORD', 'bad password');
  run.run('2026-11-12T07:00:00Z', 0, 'INVALID_PASSWORD', 'bad password');
  return { db, link };
}

describe('health check', () => {
  it('finds each kind of problem and suggestion', () => {
    const { db, link } = setup();
    const dir = mkdtempSync(join(tmpdir(), 'health-'));
    writeFileSync(join(dir, 'bank-2026-11-10.db'), '');
    const r = healthReport(db, { asOf: AS_OF, backups: { enabled: true, dir } });
    const byId = new Map(r.items.map(i => [i.id, i]));
    expect(byId.get('sync:leumi')).toMatchObject({ status: 'problem', title: 'המשיכה מלאומי נכשלה 2 פעמים ברצף', href: '/logs' });
    expect(byId.get('backup')).toMatchObject({ status: 'problem', title: 'הגיבוי האחרון לפני 7 ימים' });
    expect(byId.get('stale:leumi:1')).toMatchObject({ status: 'problem' });
    expect(byId.get('billing:max:1')).toMatchObject({ status: 'problem', href: '/settings#accounts' });
    expect(byId.get('duplicates')).toMatchObject({ status: 'problem', title: 'חיוב כפול אפשרי' });
    expect(byId.get('uncategorized')).toMatchObject({ status: 'problem', title: '1 הוצאות בלי קטגוריה ב-3 החודשים האחרונים' });
    expect(byId.get('gaps:leumi:1')?.detail).toContain('08/2026');
    expect(byId.get(`link:${link}`)).toMatchObject({ status: 'suggestion', actions: [{ path: `/links/${link}`, body: { status: 'confirmed' } }, { body: { status: 'rejected' } }] });
    expect(byId.get('planned')).toMatchObject({ status: 'suggestion', href: '/fixed#planned' });
    const rule = r.items.find(i => i.kind === 'rule');
    expect(rule).toMatchObject({ status: 'suggestion', actions: [{ method: 'POST', path: '/rules' }] });
    expect(r.problems).toBe(7);
    // problems first
    expect(r.items.findIndex(i => i.status === 'suggestion')).toBeGreaterThan(r.items.findLastIndex(i => i.status === 'problem'));
    // outside the desktop app there's no backup row
    expect(healthReport(db, { asOf: AS_OF, backups: { enabled: false } }).items.some(i => i.id === 'backup')).toBe(false);
  });

  it('a rule that covers the merchant removes the suggestion', () => {
    const { db } = setup();
    db.prepare(`INSERT INTO category_rules (match_type, pattern, set_category_id) VALUES ('contains', 'מאפיית', 1)`).run();
    expect(healthReport(db, { asOf: AS_OF }).items.some(i => i.kind === 'rule')).toBe(false);
  });

  it('"create rule" on a description with numbers makes the suggestion go away, and a second click adds no second rule', async () => {
    const db = testDb();
    addAccount(db, 'discount:1', 'bank');
    const pros = Number(db.prepare(`INSERT INTO categories (name) VALUES ('תשלום לבעלי מקצוע')`).run().lastInsertRowid);
    for (const d of ['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']) {
      const id = addTx(db, { account: 'discount:1', date: d, description: 'העברה לישראל אליאס בנק 10 ל 10-856-0003704718', amount: -120, kind: 'expense', categoryId: pros });
      db.prepare(`UPDATE transactions SET category_source = 'manual' WHERE id = ?`).run(id);
    }
    const rule = healthReport(db, { asOf: AS_OF }).items.find(i => i.kind === 'rule');
    expect(rule?.actions?.[0]).toMatchObject({ method: 'POST', path: '/rules' });
    const app = Fastify();
    transactionRoutes(app, db);
    for (let i = 0; i < 2; i++) await app.inject({ method: 'POST', url: '/api/rules', payload: rule!.actions![0].body });
    expect(db.prepare(`SELECT pattern FROM category_rules`).pluck().all()).toEqual(['העברה לישראל אליאס בנק ל']);
    expect(healthReport(db, { asOf: AS_OF }).items.some(i => i.kind === 'rule')).toBe(false);
  });

  it('"ignore" hides the row as worded now and it comes back when the wording changes', async () => {
    const { db } = setup();
    const opts = { asOf: AS_OF, backups: { enabled: false } };
    const before = healthReport(db, opts).problems;
    expect(setIgnored(db, 'duplicates', true, opts)).toBe(true);
    const r = healthReport(db, opts);
    expect(r.items.find(i => i.id === 'duplicates')).toMatchObject({ ignored: true });
    expect(r.problems).toBe(before - 1);
    // another duplicate → a different wording → it's back
    addTx(db, { account: 'leumi:1', date: '2026-11-05', description: 'ארנונה', amount: -700, kind: 'expense' });
    addTx(db, { account: 'leumi:1', date: '2026-11-06', description: 'ארנונה', amount: -700, kind: 'expense' });
    expect(healthReport(db, opts).items.find(i => i.id === 'duplicates')?.ignored).toBeUndefined();

    const app = Fastify();
    healthRoutes(app, db);
    expect((await app.inject({ method: 'PUT', url: '/api/health/ignore', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/health/ignore', payload: { id: 'nope' } })).statusCode).toBe(404);
    const res = await app.inject({ method: 'PUT', url: '/api/health/ignore', payload: { id: 'planned' } });
    expect(res.json().items.find((i: { id: string }) => i.id === 'planned')).toMatchObject({ ignored: true });
    await app.inject({ method: 'PUT', url: '/api/health/ignore', payload: { id: 'planned', ignore: false } });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().items.find((i: { id: string }) => i.id === 'planned').ignored).toBeUndefined();
  });
});
