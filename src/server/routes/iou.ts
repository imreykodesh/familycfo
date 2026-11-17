import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { round, today } from '../../analytics/common.js';
import {
  addIouPayment, createIou, deleteIou, listIous, rejectIouCandidate, removeIouPayment, setSource, type IouDirection,
} from '../../analytics/iou.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
type Body = Record<string, unknown>;

function report(db: DB) {
  const items = listIous(db);
  const open = items.filter(i => !i.doneAt);
  const sum = (d: IouDirection) => round(open.filter(i => i.direction === d).reduce((s, i) => s + i.remaining, 0));
  return { items, totals: { owedToMe: sum('owed_to_me'), iOwe: sum('i_owe') } };
}

const optDay = (v: unknown) => v == null || v === '' || (typeof v === 'string' && DAY.test(v));

export function iouRoutes(app: FastifyInstance, db: DB): void {
  app.get('/api/iou', async () => report(db));

  // {direction: owed_to_me | i_owe, person, amount, date?, dueDate?, matchPattern?, notes?, txnId?}
  app.post('/api/iou', async (req, reply) => {
    const b = (req.body ?? {}) as Body;
    const amount = Number(b.amount);
    if (b.direction !== 'owed_to_me' && b.direction !== 'i_owe') return reply.code(400).send({ error: 'direction must be owed_to_me or i_owe' });
    if (typeof b.person !== 'string' || !b.person.trim()) return reply.code(400).send({ error: 'צריך שם' });
    if (!Number.isFinite(amount) || amount <= 0) return reply.code(400).send({ error: 'סכום לא תקין' });
    if (!optDay(b.date) || !optDay(b.dueDate)) return reply.code(400).send({ error: 'dates must be YYYY-MM-DD' });
    createIou(db, {
      direction: b.direction, person: b.person, amount, date: (b.date as string) || undefined, dueDate: (b.dueDate as string) || null,
      matchPattern: typeof b.matchPattern === 'string' ? b.matchPattern : null, notes: typeof b.notes === 'string' ? b.notes : null,
      txnId: b.txnId != null ? Number(b.txnId) : null,
    });
    return report(db);
  });

  // {person, amount, date, dueDate, matchPattern, notes, done: true (close: repaid / forgiven) | false (reopen)}
  app.patch('/api/iou/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!db.prepare(`SELECT 1 FROM iou WHERE id = ?`).get(id)) return reply.code(404).send({ error: 'not found' });
    const b = (req.body ?? {}) as Body;
    const cols: Record<string, unknown> = {};
    if (b.person !== undefined) { if (typeof b.person !== 'string' || !b.person.trim()) return reply.code(400).send({ error: 'צריך שם' }); cols.person = b.person.trim(); }
    if (b.amount !== undefined) { const a = Number(b.amount); if (!Number.isFinite(a) || a <= 0) return reply.code(400).send({ error: 'סכום לא תקין' }); cols.amount = a; }
    if (b.date !== undefined) { if (!b.date || !optDay(b.date)) return reply.code(400).send({ error: 'date must be YYYY-MM-DD' }); cols.date = b.date; }
    if (b.dueDate !== undefined) { if (!optDay(b.dueDate)) return reply.code(400).send({ error: 'dueDate must be YYYY-MM-DD' }); cols.due_date = b.dueDate || null; }
    if (b.matchPattern !== undefined) cols.match_pattern = typeof b.matchPattern === 'string' && b.matchPattern.trim() ? b.matchPattern.trim() : null;
    if (b.notes !== undefined) cols.notes = b.notes ? String(b.notes) : null;
    if (b.done !== undefined) cols.done_at = b.done ? today() : null;
    const keys = Object.keys(cols);
    if (keys.length) db.prepare(`UPDATE iou SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @__id`).run({ ...cols, __id: id });
    return report(db);
  });

  app.delete('/api/iou/:id', async req => { deleteIou(db, Number((req.params as { id: string }).id)); return report(db); });

  // a repayment: {txnId} (date and amount from the row) or {date, amount}
  app.post('/api/iou/:id/payments', async (req, reply) => {
    const b = (req.body ?? {}) as Body;
    if (!optDay(b.date)) return reply.code(400).send({ error: 'date must be YYYY-MM-DD' });
    const err = addIouPayment(db, Number((req.params as { id: string }).id), {
      date: (b.date as string) || undefined, amount: b.amount != null && b.amount !== '' ? Number(b.amount) : undefined,
      txnId: b.txnId != null ? Number(b.txnId) : null,
    });
    if (err) return reply.code(err === 'not found' ? 404 : 400).send({ error: err });
    return report(db);
  });

  app.delete('/api/iou/:id/payments/:pid', async req => {
    const p = req.params as { id: string; pid: string };
    removeIouPayment(db, Number(p.id), Number(p.pid));
    return report(db);
  });

  // the row the money was lent / borrowed in: {txnId} or {txnId: null}
  app.put('/api/iou/:id/source', async (req, reply) => {
    const b = (req.body ?? {}) as Body;
    const err = setSource(db, Number((req.params as { id: string }).id), b.txnId != null ? Number(b.txnId) : null);
    if (err) return reply.code(err === 'not found' ? 404 : 400).send({ error: err });
    return report(db);
  });

  // "not it": {txnId}
  app.post('/api/iou/:id/reject', async (req, reply) => {
    const txnId = Number(((req.body ?? {}) as Body).txnId);
    if (!Number.isInteger(txnId)) return reply.code(400).send({ error: 'txnId is required' });
    rejectIouCandidate(db, Number((req.params as { id: string }).id), txnId);
    return report(db);
  });
}
