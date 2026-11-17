import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { listChargeMoves, moveCandidates, nextChargeDay, sameMerchant, verifyChargeMoves } from '../src/analytics/chargeMoves.js';
import { generateAlerts } from '../src/analytics/alerts.js';
import { refreshRecurring } from '../src/analytics/recurring.js';
import { chargeMoveRoutes } from '../src/server/routes/chargeMoves.js';
import { addAccount, addTx, testDb } from './helpers.js';

const AS_OF = '2026-11-17';

function setup() {
  const db = testDb();
  addAccount(db, 'isracard:1', 'card');
  addAccount(db, 'max:2', 'card');
  for (const m of ['08', '09', '10', '11']) {
    addTx(db, { account: 'isracard:1', date: `2026-${m}-03`, description: 'NETFLIX.COM', amount: -55, kind: 'expense' });
    addTx(db, { account: 'isracard:1', date: `2026-${m}-08`, description: 'חדר כושר אנרגיה', amount: -250, kind: 'expense' });
  }
  refreshRecurring(db, AS_OF);
  const series = (key: string) => db.prepare(`SELECT id FROM recurring_series WHERE merchant_key = ?`).pluck().get(key) as number;
  const app = Fastify();
  chargeMoveRoutes(app, db);
  return { db, app, netflix: series('netflix com'), gym: series('חדר כושר אנרגיה') };
}

describe('charge moves', () => {
  it('helpers', () => {
    expect(sameMerchant('netflix com', 'netflix')).toBe(true);
    expect(sameMerchant('abc', 'abcd')).toBe(false);
    expect(nextChargeDay('2026-11-17', 3)).toBe('2026-12-03');
    expect(nextChargeDay('2026-11-01', 3)).toBe('2026-11-03');
    expect(nextChargeDay('2026-12-20', 31)).toBe('2026-12-31');
    expect(nextChargeDay('2027-01-31', 31)).toBe('2027-02-28');
  });

  it('lists the old card\'s recurring charges and builds a move list', async () => {
    const { db, app, netflix, gym } = setup();
    const candidates = moveCandidates(db, 'isracard:1');
    expect(candidates.map(c => c.description).sort()).toEqual(['NETFLIX.COM', 'חדר כושר אנרגיה']);
    const res = await app.inject({ method: 'POST', url: '/api/charge-moves', payload: { fromAccountId: 'isracard:1', toAccountId: 'max:2', seriesIds: [netflix, gym] } });
    expect(res.json().created).toBe(2);
    expect(listChargeMoves(db).map(m => m.status)).toEqual(['todo', 'todo']);
    expect(moveCandidates(db, 'isracard:1').every(c => c.listed)).toBe(true);
    // listed already → not added twice; bad bodies
    expect((await app.inject({ method: 'POST', url: '/api/charge-moves', payload: { fromAccountId: 'isracard:1', toAccountId: 'max:2', seriesIds: [netflix] } })).json().created).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/api/charge-moves', payload: { fromAccountId: 'isracard:1', toAccountId: 'isracard:1', seriesIds: [netflix] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/charge-moves/candidates?from=nope' })).statusCode).toBe(400);
  });

  it('verified when it shows up on the new card; failed (with an alert) when the old card is charged again', async () => {
    const { db, app, netflix, gym } = setup();
    await app.inject({ method: 'POST', url: '/api/charge-moves', payload: { fromAccountId: 'isracard:1', toAccountId: 'max:2', seriesIds: [netflix, gym] } });
    const [n, g] = ['NETFLIX.COM', 'חדר כושר אנרגיה'].map(d => listChargeMoves(db).find(m => m.description === d)!.id);
    db.prepare(`UPDATE charge_moves SET status = 'moved', marked_at = '2026-11-20'`).run();
    // December: Netflix arrives on Max (written a bit differently); the gym still charges the old card
    addTx(db, { account: 'max:2', date: '2026-12-03', description: 'NETFLIX', amount: -55, kind: 'expense' });
    addTx(db, { account: 'isracard:1', date: '2026-12-08', description: 'חדר כושר אנרגיה', amount: -250, kind: 'expense' });
    expect(verifyChargeMoves(db, '2026-12-10')).toEqual({ verified: 1, failed: 1 });
    const moves = new Map(listChargeMoves(db).map(m => [m.id, m]));
    expect(moves.get(n)).toMatchObject({ status: 'verified', verifiedAt: '2026-12-10', evidence: { accountId: 'max:2', amount: -55 } });
    // (the test helper stores midnight at +03:00, so in winter the row reads as the 7th)
    expect(moves.get(g)).toMatchObject({ status: 'failed', evidence: { accountId: 'isracard:1', date: expect.stringMatching(/^2026-12-0[78]$/) } });
    const alert = generateAlerts(db, '2026-12-10').find(a => a.type === 'move_still_on_old');
    expect(alert).toMatchObject({ title: 'חדר כושר אנרגיה עדיין יורד מisracard:1', dedupeKey: expect.stringMatching(/^move-old:/) });
    // the user fixes it and ticks it again: back to waiting, from that day
    const again = (await app.inject({ method: 'PATCH', url: `/api/charge-moves/${g}`, payload: { status: 'moved' } })).json();
    expect(again).toMatchObject({ status: 'moved', evidence: null });
    expect(again.markedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(netflix).toBeGreaterThan(0);
  });

  it('a cancelled charge is verified once its day passed uncharged, and fails if it comes back', async () => {
    const { db, app, gym } = setup();
    // "I cancelled it" from the subscriptions list: marked from today
    await app.inject({ method: 'POST', url: '/api/charge-moves', payload: { fromAccountId: 'isracard:1', toAccountId: null, seriesIds: [gym], marked: true } });
    const id = listChargeMoves(db)[0].id;
    db.prepare(`UPDATE charge_moves SET marked_at = '2026-11-10' WHERE id = ?`).run(id);
    // the usual day is the 8th: 8 Dec + 5 days, and the card was scraped after that
    db.prepare(`UPDATE accounts SET last_scraped_at = '2026-12-14T06:00:00Z' WHERE id = 'isracard:1'`).run();
    expect(verifyChargeMoves(db, '2026-12-12')).toEqual({ verified: 0, failed: 0 });
    expect(verifyChargeMoves(db, '2026-12-14')).toEqual({ verified: 1, failed: 0 });
    expect(listChargeMoves(db)[0]).toMatchObject({ status: 'verified', toAccountId: null });
    // charged again in January (a bit more expensive)
    addTx(db, { account: 'isracard:1', date: '2027-01-08', description: 'חדר כושר אנרגיה', amount: -280, kind: 'expense' });
    expect(verifyChargeMoves(db, '2027-01-10')).toEqual({ verified: 0, failed: 1 });
    expect(generateAlerts(db, '2027-01-10').find(a => a.type === 'cancel_failed')).toMatchObject({ title: 'חדר כושר אנרגיה חויב שוב אחרי הביטול' });
  });
});
