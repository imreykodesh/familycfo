import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { addDays, loadTransactions } from '../src/analytics/common.js';
import { hebrewParts, lastOccurrence, nextOccurrence, occurrences } from '../src/analytics/hebcal.js';
import { monthlySetAside, seasonalPlan, suggestFromHistory } from '../src/analytics/seasonal.js';
import { buildAllowance, computeAllowance } from '../src/analytics/allowance.js';
import { savingsCapacity } from '../src/analytics/planning.js';
import { generateAlerts } from '../src/analytics/alerts.js';
import { seasonalRoutes } from '../src/server/routes/seasonal.js';
import { addAccount, addBalance, addTx, testDb } from './helpers.js';

describe('hebrew calendar', () => {
  it('finds the next Pesach and Rosh Hashana', () => {
    expect(nextOccurrence('hebrew', 'Nisan', 15, '2026-11-17')).toBe('2027-04-22');
    expect(nextOccurrence('hebrew', 'Tishri', 1, '2026-11-17')).toBe('2027-10-02');
    expect(nextOccurrence('hebrew', 'Tishri', 1, '2026-09-12')).toBe('2026-09-12');
  });

  it('puts Purim in Adar II in a leap year and in Adar in a plain one', () => {
    expect(hebrewParts('2027-02-21').month).toBe('Adar I');
    expect(nextOccurrence('hebrew', 'Adar', 14, '2026-11-17')).toBe('2027-03-23');
    expect(nextOccurrence('hebrew', 'Adar', 14, '2027-04-01')).toBe('2028-03-12');
  });

  it('falls on the last day of the month when the day is missing that year', () => {
    // Heshvan has 29 days in 5786: 30 Heshvan falls on 29 Heshvan; in 5787 it has 30
    const date = nextOccurrence('hebrew', 'Heshvan', 30, '2025-10-01');
    expect(date).toBe('2025-11-20');
    expect(hebrewParts(date)).toEqual({ month: 'Heshvan', day: 29 });
    expect(nextOccurrence('hebrew', 'Heshvan', 30, '2026-10-01')).toBe('2026-11-10');
    expect(hebrewParts(addDays(date, 1)).month).toBe('Kislev');
  });

  it('handles Gregorian dates, including a 31st in a short month', () => {
    expect(nextOccurrence('gregorian', '9', 1, '2026-11-17')).toBe('2027-09-01');
    expect(occurrences('gregorian', '2', 31, '2026-01-01', '2028-12-31')).toEqual(['2026-02-28', '2027-02-28', '2028-02-29']);
    expect(lastOccurrence('gregorian', '9', 1, '2026-11-17')).toBe('2026-09-01');
  });
});

describe('expected-events fund', () => {
  it('puts aside the lowest monthly amount that covers every event by its date', () => {
    // 1,000 in 2 months → 500/month; 1,000 + 3,000 in 5 months → 800/month, which also covers the first
    expect(monthlySetAside([{ amount: 3000, daysUntil: 5 * 30.44 }, { amount: 1000, daysUntil: 2 * 30.44 }], 0)).toBe(800);
    // money in the pot lowers it; a covered year needs nothing
    expect(monthlySetAside([{ amount: 1000, daysUntil: 2 * 30.44 }, { amount: 3000, daysUntil: 5 * 30.44 }], 1500)).toBe(500);
    expect(monthlySetAside([{ amount: 1000, daysUntil: 60 }], 1000)).toBe(0);
    // an event within a month needs all of it now
    expect(monthlySetAside([{ amount: 900, daysUntil: 10 }], 0)).toBe(900);
  });

  it('suggests an amount from the extra spending around the date in past years', () => {
    const db = testDb();
    addAccount(db, 'max:1', 'card');
    // 100 a day for a year and a half, plus 3,000 more in the two weeks before Pesach 5786 (2.4.2026)
    for (let d = '2025-06-01'; d <= '2026-11-01'; d = addDays(d, 1)) addTx(db, { account: 'max:1', date: d, description: 'סופר', amount: -100, kind: 'expense' });
    for (let i = 0; i < 10; i++) addTx(db, { account: 'max:1', date: addDays('2026-03-20', i), description: 'שוק', amount: -300, kind: 'expense' });
    const suggested = suggestFromHistory(loadTransactions(db), 'hebrew', 'Nisan', 15, '2026-11-17')!;
    // ±100: the helper stores dates as +03:00, so winter days can shift by one at the window's edge
    expect(suggested).toBeGreaterThanOrEqual(2900);
    expect(suggested).toBeLessThanOrEqual(3100);
    // Pesach 5785 (13.4.2025) is before the data starts: not counted, so no guess from it
    expect(suggestFromHistory(loadTransactions(db), 'hebrew', 'Nisan', 15, '2025-12-01')).toBeNull();
  });

  it('plans events, asks about the one that passed and settles it through the API', async () => {
    const db = testDb();
    const app = Fastify();
    seasonalRoutes(app, db);
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/seasonal', payload });
    expect((await post({ name: 'פסח', month: 'Nisan', day: 15, amount: 4000 })).statusCode).toBe(200);
    expect((await post({ name: 'x', month: 'Nisan', day: 45, amount: 1 })).statusCode).toBe(400);
    expect((await post({ name: 'x', calendar: 'gregorian', month: 'Nisan', day: 1, amount: 1 })).statusCode).toBe(400);
    const school = (await post({ name: 'ציוד לבית ספר', calendar: 'gregorian', month: '9', day: 1, amount: 1200 })).json();
    // created long ago, so the September that passed waits for an answer
    db.prepare(`UPDATE seasonal_events SET created_at = '2026-01-01 10:00:00' WHERE id = ?`).run(school.id);
    await app.inject({ method: 'PUT', url: '/api/seasonal/pot', payload: { balance: 2000 } });

    const plan = seasonalPlan(db, { asOf: '2026-11-17' });
    expect(plan.pot.balance).toBe(2000);
    expect(plan.events.map(e => [e.name, e.nextDate, e.dateLabel])).toEqual([['פסח', '2027-04-22', 'ט״ו בניסן'], ['ציוד לבית ספר', '2027-09-01', '1.9']]);
    expect(plan.events[0].covered).toBe(false);
    expect(plan.events.find(e => e.id === school.id)!.pendingSettle).toBe('2026-09-01');
    expect(plan.suggestions.map(s => s.key)).toEqual(['tishri', 'hanukkah', 'purim', 'summer']);
    expect(generateAlerts(db, '2026-11-17').filter(a => a.type === 'seasonal_settle')).toHaveLength(1);

    const settled = await app.inject({ method: 'POST', url: `/api/seasonal/${school.id}/settle`, payload: { date: '2026-09-01', spent: 900 } });
    expect(settled.json().pot.balance).toBe(1100);
    expect(seasonalPlan(db, { asOf: '2026-11-17' }).events.every(e => e.pendingSettle == null)).toBe(true);
  });

  it('keeps the pot out of the recommended savings split', () => {
    const db = testDb();
    db.prepare(`INSERT INTO sinking_funds (name, kind) VALUES ('קופה לאירועים צפויים', 'seasonal')`).run();
    expect(savingsCapacity(db).allocation.map(a => a.name)).toEqual(['חיסכון', 'חופשות', 'הוצאות חריגות']);
  });
});

describe('daily allowance', () => {
  const base = { asOf: '2026-11-01', until: '2026-11-30', startBalance: 10000, buffer: 2000 };

  it('spreads what is left above the buffer over the days to the end', () => {
    const r = computeAllowance({ ...base, flows: [] });
    expect(r).toMatchObject({ perDay: 267, bindingDate: '2026-11-30', daysLeft: 30, shortfall: 0 });
  });

  it('is limited by the low point before the salary arrives', () => {
    const r = computeAllowance({ ...base, flows: [
      { date: '2026-11-05', amount: -5000, name: 'משכנתא' },
      { date: '2026-11-10', amount: 12000, name: 'משכורת' },
    ] });
    // (10,000 − 5,000 − 2,000) over the 9 days until the salary on the 10th
    expect(r).toMatchObject({ perDay: 333, bindingDate: '2026-11-09', bindingDays: 9, endBalance: 17000 });
  });

  it('says there is no room when the known payments alone go below the buffer', () => {
    const r = computeAllowance({ ...base, flows: [{ date: '2026-11-03', amount: -9000, name: 'ויזה' }] });
    expect(r.perDay).toBeLessThan(0);
    expect(r).toMatchObject({ shortfall: 1000, lowest: { date: '2026-11-03', balance: 1000 } });
  });

  it('takes the expected-events set-aside off every day', () => {
    expect(computeAllowance({ ...base, flows: [], reservePerDay: 30 }).perDay).toBe(237);
  });

  it('counts only the certain part of a card statement', () => {
    const db = testDb();
    addAccount(db, 'leumi:1', 'bank');
    addAccount(db, 'max:1', 'card', 1, 'leumi:1');
    addBalance(db, 'leumi:1', 10000);
    const asOf = '2026-11-01';
    // three past statements of 3,000 everyday purchases (charged on the 10th); the open one has 500 so far
    for (const [m, next] of [['07', '08'], ['08', '09'], ['09', '10']]) {
      addTx(db, { account: 'max:1', date: `2026-${m}-05`, processedDate: `2026-${next}-10`, description: 'סופר', amount: -3000, kind: 'expense' });
    }
    addTx(db, { account: 'max:1', date: '2026-10-20', processedDate: '2026-11-10', description: 'סופר', amount: -500, kind: 'expense' });
    const a = buildAllowance(db, { asOf });
    expect(a.outgoing).toBe(500);
    expect(a.until).toBe('2026-11-30');
  });
});
