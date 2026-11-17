import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { listIous } from '../src/analytics/iou.js';
import { generateAlerts } from '../src/analytics/alerts.js';
import { iouRoutes } from '../src/server/routes/iou.js';
import { addAccount, addTx, testDb } from './helpers.js';

function setup() {
  const db = testDb();
  addAccount(db, 'leumi:1', 'bank');
  const lent = addTx(db, { account: 'leumi:1', date: '2026-10-05', description: 'העברה בביט לדנה כהן', amount: -1000, kind: 'expense' });
  const back1 = addTx(db, { account: 'leumi:1', date: '2026-10-20', description: 'ביט מדנה כהן', amount: 400, kind: 'income' });
  const back2 = addTx(db, { account: 'leumi:1', date: '2026-11-03', description: 'ביט מדנה כהן', amount: 600, kind: 'income' });
  addTx(db, { account: 'leumi:1', date: '2026-11-04', description: 'ביט מיוסי', amount: 600, kind: 'income' });
  const app = Fastify();
  iouRoutes(app, db);
  return { db, app, lent, back1, back2 };
}
const kindOf = (db: ReturnType<typeof setup>['db'], id: number) => db.prepare(`SELECT kind, kind_source FROM transactions WHERE id = ?`).get(id);

describe('personal loans', () => {
  it('suggests the loan row and the repayments that mention the person, and closes when repaid', async () => {
    const { db, app, lent, back1, back2 } = setup();
    let r = (await app.inject({ method: 'POST', url: '/api/iou', payload: { direction: 'owed_to_me', person: 'דנה', amount: 1000, date: '2026-10-05', dueDate: '2026-11-01' } })).json();
    const id = r.items[0].id;
    expect(r.items[0]).toMatchObject({ remaining: 1000, sourceCandidates: [{ id: lent }], paymentCandidates: [{ id: back1 }, { id: back2 }] });
    expect(r.totals).toEqual({ owedToMe: 1000, iOwe: 0 });

    // the loan row and the first repayment become transfers (not spend / income)
    r = (await app.inject({ method: 'PUT', url: `/api/iou/${id}/source`, payload: { txnId: lent } })).json();
    expect(r.items[0].source).toMatchObject({ id: lent, amount: -1000 });
    expect(kindOf(db, lent)).toEqual({ kind: 'transfer', kind_source: 'manual' });
    r = (await app.inject({ method: 'POST', url: `/api/iou/${id}/payments`, payload: { txnId: back1 } })).json();
    expect(r.items[0]).toMatchObject({ paid: 400, remaining: 600, doneAt: null, paymentCandidates: [{ id: back2 }] });
    expect(kindOf(db, back1)).toEqual({ kind: 'transfer', kind_source: 'manual' });

    // overdue → alerts: the due date and the row that looks like the rest
    const alerts = generateAlerts(db, '2026-11-10').filter(a => a.type.startsWith('iou'));
    expect(alerts.map(a => a.type).sort()).toEqual(['iou_due', 'iou_payment']);

    r = (await app.inject({ method: 'POST', url: `/api/iou/${id}/payments`, payload: { txnId: back2 } })).json();
    expect(r.items[0]).toMatchObject({ remaining: 0, paymentCandidates: [] });
    expect(r.items[0].doneAt).toBeTruthy();
    expect(r.totals.owedToMe).toBe(0);
    // a row already used can't be used twice
    expect((await app.inject({ method: 'POST', url: `/api/iou/${id}/payments`, payload: { txnId: back2 } })).statusCode).toBe(400);

    // removing a payment reopens it and gives the row its kind back
    const pid = r.items[0].payments[1].id;
    r = (await app.inject({ method: 'DELETE', url: `/api/iou/${id}/payments/${pid}` })).json();
    expect(r.items[0]).toMatchObject({ remaining: 600, doneAt: null });
    expect(kindOf(db, back2)).toEqual({ kind: 'income', kind_source: 'auto' });
    // deleting the loan restores every linked row
    await app.inject({ method: 'DELETE', url: `/api/iou/${id}` });
    expect(kindOf(db, lent)).toEqual({ kind: 'expense', kind_source: 'auto' });
    expect(kindOf(db, back1)).toEqual({ kind: 'income', kind_source: 'auto' });
  });

  it('"I owe", manual payments, "not it" and validation', async () => {
    const { db, app, back1 } = setup();
    let r = (await app.inject({ method: 'POST', url: '/api/iou', payload: { direction: 'i_owe', person: 'אבא', amount: 5000, date: '2026-09-01' } })).json();
    const id = r.items[0].id;
    r = (await app.inject({ method: 'POST', url: `/api/iou/${id}/payments`, payload: { date: '2026-10-01', amount: 2000 } })).json();
    expect(r.items[0]).toMatchObject({ paid: 2000, remaining: 3000, payments: [{ date: '2026-10-01', amount: 2000, txnId: null }] });
    expect(r.totals.iOwe).toBe(3000);

    r = (await app.inject({ method: 'POST', url: '/api/iou', payload: { direction: 'owed_to_me', person: 'דנה', amount: 400, date: '2026-10-01' } })).json();
    const dana = r.items.find((i: { person: string }) => i.person === 'דנה').id;
    await app.inject({ method: 'POST', url: `/api/iou/${dana}/reject`, payload: { txnId: back1 } });
    expect(listIous(db).find(i => i.id === dana)!.paymentCandidates.map(c => c.id)).not.toContain(back1);

    expect((await app.inject({ method: 'POST', url: '/api/iou', payload: { direction: 'x', person: 'a', amount: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/iou', payload: { direction: 'i_owe', person: 'a', amount: -5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/iou/999', payload: { done: true } })).statusCode).toBe(404);
    // closed by hand (forgiven)
    r = (await app.inject({ method: 'PATCH', url: `/api/iou/${id}`, payload: { done: true } })).json();
    expect(r.items.find((i: { id: number }) => i.id === id).doneAt).toBeTruthy();
  });
});
