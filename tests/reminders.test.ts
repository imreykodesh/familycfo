import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { autoReminders, fireDueReminders, listReminders, nowLocal, occurrence, occurrencesAround } from '../src/analytics/reminders.js';
import { refreshAlerts, takeAlertsToNotify } from '../src/analytics/alerts.js';
import { reminderRoutes } from '../src/server/routes/reminders.js';
import { addAccount, testDb } from './helpers.js';

describe('reminders', () => {
  it('occurrences keep the start day, clamped to the month', () => {
    expect(occurrence('2026-01-31T09:00', 'monthly', 1)).toBe('2026-02-28T09:00');
    expect(occurrence('2026-01-31T09:00', 'monthly', 2)).toBe('2026-03-31T09:00');
    expect(occurrence('2024-02-29T20:30', 'yearly', 1)).toBe('2025-02-28T20:30');
    expect(occurrence('2026-11-15T08:00', 'monthly', 2)).toBe('2027-01-15T08:00');
    expect(occurrencesAround('2026-10-10T09:00', 'monthly', '2026-11-17T12:00')).toEqual({ last: '2026-11-10T09:00', next: '2026-12-10T09:00' });
    expect(occurrencesAround('2026-12-01T09:00', 'once', '2026-11-17T12:00')).toEqual({ last: null, next: '2026-12-01T09:00' });
    expect(nowLocal(new Date('2026-07-01T06:30:00Z'))).toBe('2026-07-01T09:30'); // summer: UTC+3
  });

  it('a reminder becomes an alert (with its screen) at its time, once per occurrence', () => {
    const db = testDb();
    db.prepare(`INSERT INTO reminders (text, start_at, repeat, href) VALUES ('לשלם ועד בית', '2026-11-10T09:00', 'monthly', '/fixed')`).run();
    db.prepare(`INSERT INTO reminders (text, start_at) VALUES ('להתקשר לביטוח', '2026-11-17T18:00')`).run();
    expect(fireDueReminders(db, '2026-11-17T12:00')).toBe(1);
    expect(fireDueReminders(db, '2026-11-17T12:01')).toBe(0); // the same occurrence doesn't fire twice
    expect(fireDueReminders(db, '2026-11-17T18:00')).toBe(1);
    const notices = takeAlertsToNotify(db);
    expect(notices.map(n => [n.title, n.href])).toEqual([['לשלם ועד בית', '/fixed'], ['להתקשר לביטוח', null]]);
    const list = listReminders(db, '2026-11-17T18:05');
    expect(list.find(r => r.text === 'לשלם ועד בית')).toMatchObject({ nextAt: '2026-12-10T09:00', lastFiredAt: '2026-11-10T09:00' });
    expect(list.find(r => r.text === 'להתקשר לביטוח')).toMatchObject({ nextAt: null, doneAt: '2026-11-17T18:00' });
    expect(fireDueReminders(db, '2026-12-10T09:00')).toBe(1);
  });

  it('automatic reminders from insurance, loans, a study fund and planned expenses', () => {
    const db = testDb();
    addAccount(db, 'leumi:1', 'bank');
    db.prepare(`INSERT INTO insurance_policies (name, insurer, end_date) VALUES ('ביטוח רכב', 'הראל', '2026-12-10')`).run();
    db.prepare(`INSERT INTO insurance_policies (name, end_date, archived) VALUES ('ישן', '2026-12-10', 1)`).run();
    db.prepare(`INSERT INTO liabilities (name, type, end_date) VALUES ('הלוואת רכב', 'loan', '2027-02-01')`).run();
    db.prepare(`INSERT INTO assets (name, type, liquidity_date) VALUES ('השתלמות', 'keren_hishtalmut', '2026-12-01')`).run();
    db.prepare(`INSERT INTO planned_items (description, amount, date, account_id) VALUES ('מקרר', 4000, '2026-11-19', 'leumi:1')`).run();
    const auto = autoReminders(db, '2026-11-17');
    expect(auto.map(a => [a.kind, a.remindOn, a.href])).toEqual([
      ['insurance', '2026-11-10', '/insurance'], ['study_fund', '2026-11-01', '/pension'], ['planned', '2026-11-16', '/fixed#planned'], ['loan', '2027-01-02', '/loans'],
    ].sort((a, b) => a[1].localeCompare(b[1])));
    // due today: the insurance, the study fund and the planned expense; the loan only in January
    expect(fireDueReminders(db, '2026-11-17T08:00')).toBe(3);
    expect(fireDueReminders(db, '2026-11-18T08:00')).toBe(0);
    // the pipeline's alerts and the reminders share the table without clashing
    expect(refreshAlerts(db, '2026-11-17')).toBeGreaterThanOrEqual(0);
  });

  it('API: create, validate, stop', async () => {
    const db = testDb();
    const app = Fastify();
    reminderRoutes(app, db);
    let r = (await app.inject({ method: 'POST', url: '/api/reminders', payload: { text: 'חידוש דרכון', at: '2030-03-01T10:00', repeat: 'yearly', href: '/settings' } })).json();
    expect(r.reminders[0]).toMatchObject({ text: 'חידוש דרכון', nextAt: '2030-03-01T10:00', repeat: 'yearly' });
    const id = r.reminders[0].id;
    expect((await app.inject({ method: 'POST', url: '/api/reminders', payload: { text: 'x', at: '2030-03-01' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/reminders', payload: { text: 'x', at: '2030-03-01T10:00', href: 'https://evil.example' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/reminders', payload: { text: 'x', at: '2030-03-01T10:00', repeat: 'daily' } })).statusCode).toBe(400);
    r = (await app.inject({ method: 'PATCH', url: `/api/reminders/${id}`, payload: { done: true } })).json();
    expect(r.reminders[0]).toMatchObject({ nextAt: null });
    expect(r.reminders[0].doneAt).toBeTruthy();
  });
});
