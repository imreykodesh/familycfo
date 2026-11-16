import { describe, expect, it } from 'vitest';
import { balanceHistory, dataCoverage } from '../src/analytics/balances.js';
import { addAccount, addBalance, addTx, testDb } from './helpers.js';

describe('balance history', () => {
  it('rebuilds past balances back from the current one and finds when the overdraft started', () => {
    const db = testDb();
    addAccount(db, 'bank:1', 'bank');
    addBalance(db, 'bank:1', -500, '2026-08-10T08:00:00');
    addTx(db, { account: 'bank:1', date: '2026-06-05', amount: 1000, description: 'salary' });
    addTx(db, { account: 'bank:1', date: '2026-07-01', amount: -2500, description: 'rent' });
    addTx(db, { account: 'bank:1', date: '2026-08-01', amount: 200, description: 'refund' });
    addTx(db, { account: 'bank:1', date: '2026-08-05', amount: -200, description: 'shop' });

    const [h] = balanceHistory(db, { daily: true, to: '2026-08-10' });
    // before the first row: -500 - (1000 - 2500 + 200 - 200) = 1000
    expect(h.balanceBeforeHistory).toBe(1000);
    expect(h.historyFrom).toBe('2026-06-05');
    const at = (d: string) => h.daily!.find(p => p.date === d)?.balance;
    expect(at('2026-06-05')).toBe(2000);
    expect(at('2026-06-30')).toBe(2000);
    expect(at('2026-07-01')).toBe(-500);
    expect(at('2026-08-01')).toBe(-300);
    expect(at('2026-08-05')).toBe(-500);
    expect(h.negativeSince).toBe('2026-07-01');
    expect(h.negativeSinceBeforeHistory).toBe(false);
    const jul = h.monthly.find(m => m.month === '2026-07')!;
    expect(jul).toMatchObject({ start: 2000, min: -500, minDate: '2026-07-01', end: -500, daysNegative: 31 });
  });

  it('reports the data range of each account', () => {
    const db = testDb();
    addAccount(db, 'card:1', 'card');
    addTx(db, { account: 'card:1', date: '2025-05-10', amount: -50, description: 'a' });
    addTx(db, { account: 'card:1', date: '2025-06-10', amount: -50, description: 'b' });
    expect(dataCoverage(db).find(c => c.accountId === 'card:1')).toMatchObject({ firstDate: '2025-05-10', lastDate: '2025-06-10', rows: 2 });
  });
});
