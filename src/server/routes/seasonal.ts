import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { isValidMonth, type Calendar } from '../../analytics/hebcal.js';
import { ensureSeasonalPot, seasonalPlan, settleSeasonalEvent } from '../../analytics/seasonal.js';
import { buildAllowance } from '../../analytics/allowance.js';
import { parseFilter } from './transactions.js';
import { toApi } from '../crud.js';

type Body = { name?: unknown; calendar?: unknown; month?: unknown; day?: unknown; amount?: unknown; active?: unknown; notes?: unknown };

/** Validate an event body; `partial` for PATCH. Returns the snake_case columns or an error message. */
function eventColumns(b: Body, current?: { calendar: Calendar; month: string }): Record<string, unknown> | string {
  const out: Record<string, unknown> = {};
  if (b.name !== undefined) {
    const name = String(b.name ?? '').trim();
    if (!name) return 'צריך שם לאירוע';
    out.name = name;
  }
  const calendar = (b.calendar ?? current?.calendar ?? 'hebrew') as Calendar;
  if (calendar !== 'hebrew' && calendar !== 'gregorian') return 'calendar must be hebrew or gregorian';
  if (b.calendar !== undefined) out.calendar = calendar;
  if (b.month !== undefined || b.calendar !== undefined) {
    const month = String(b.month ?? current?.month ?? '');
    if (!isValidMonth(calendar, month)) return 'חודש לא תקין';
    out.month = month;
  }
  if (b.day !== undefined) {
    const day = Number(b.day);
    if (!Number.isInteger(day) || day < 1 || day > (calendar === 'hebrew' ? 30 : 31)) return 'יום לא תקין';
    out.day = day;
  }
  if (b.amount !== undefined) {
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount < 0) return 'סכום לא תקין';
    out.amount = amount;
  }
  if (b.active !== undefined) out.active = b.active ? 1 : 0;
  if (b.notes !== undefined) out.notes = b.notes ? String(b.notes) : null;
  return out;
}

export function seasonalRoutes(app: FastifyInstance, db: DB): void {
  app.get('/api/seasonal', async () => seasonalPlan(db));

  app.post('/api/seasonal', async (req, reply) => {
    const b = (req.body ?? {}) as Body;
    if (b.name === undefined || b.month === undefined || b.day === undefined || b.amount === undefined) {
      return reply.code(400).send({ error: 'name, month, day and amount are required' });
    }
    const cols = eventColumns({ calendar: 'hebrew', ...b });
    if (typeof cols === 'string') return reply.code(400).send({ error: cols });
    ensureSeasonalPot(db);
    const keys = Object.keys(cols);
    const id = db.prepare(`INSERT INTO seasonal_events (${keys.join(', ')}) VALUES (${keys.map(k => `@${k}`).join(', ')})`).run(cols).lastInsertRowid;
    return toApi(db.prepare(`SELECT * FROM seasonal_events WHERE id = ?`).get(id) as Record<string, unknown>);
  });

  app.patch('/api/seasonal/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const current = db.prepare(`SELECT calendar, month FROM seasonal_events WHERE id = ?`).get(id) as { calendar: Calendar; month: string } | undefined;
    if (!current) return reply.code(404).send({ error: 'not found' });
    const cols = eventColumns((req.body ?? {}) as Body, current);
    if (typeof cols === 'string') return reply.code(400).send({ error: cols });
    const keys = Object.keys(cols);
    if (!keys.length) return reply.code(400).send({ error: 'no fields' });
    db.prepare(`UPDATE seasonal_events SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @__id`).run({ ...cols, __id: id });
    return toApi(db.prepare(`SELECT * FROM seasonal_events WHERE id = ?`).get(id) as Record<string, unknown>);
  });

  app.delete('/api/seasonal/:id', async req => {
    db.prepare(`DELETE FROM seasonal_events WHERE id = ?`).run(Number((req.params as { id: string }).id));
    return { ok: true };
  });

  // an event passed: how much it took from the pot (0 = nothing)
  app.post('/api/seasonal/:id/settle', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { date?: unknown; spent?: unknown };
    const date = String(b.date ?? '');
    const spent = Number(b.spent ?? 0);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply.code(400).send({ error: 'date must be YYYY-MM-DD' });
    if (!Number.isFinite(spent) || spent < 0) return reply.code(400).send({ error: 'סכום לא תקין' });
    if (!db.prepare(`SELECT 1 FROM seasonal_events WHERE id = ?`).get(id)) return reply.code(404).send({ error: 'not found' });
    settleSeasonalEvent(db, id, date, spent);
    return { ok: true, pot: seasonalPlan(db, { withSuggestions: false }).pot };
  });

  app.put('/api/seasonal/pot', async (req, reply) => {
    const balance = Number((req.body as { balance?: unknown } | undefined)?.balance);
    if (!Number.isFinite(balance)) return reply.code(400).send({ error: 'balance is required' });
    const fundId = ensureSeasonalPot(db);
    db.prepare(`UPDATE sinking_funds SET balance = ? WHERE id = ?`).run(balance, fundId);
    return { ok: true, pot: { fundId, balance } };
  });

  app.get('/api/allowance', async req => buildAllowance(db, { filter: parseFilter(req.query as Record<string, string | undefined>) }));
}
