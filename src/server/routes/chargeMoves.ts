import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { addChargeMoves, listChargeMoves, markChargeMove, moveCandidates, verifyChargeMoves } from '../../analytics/chargeMoves.js';

const accountExists = (db: DB, id: unknown) => typeof id === 'string' && !!db.prepare(`SELECT 1 FROM accounts WHERE id = ?`).get(id);

export function chargeMoveRoutes(app: FastifyInstance, db: DB): void {
  app.get('/api/charge-moves', async () => listChargeMoves(db));

  // the active recurring charges of the old account, to pick from
  app.get('/api/charge-moves/candidates', async (req, reply) => {
    const from = (req.query as { from?: string }).from;
    if (!accountExists(db, from)) return reply.code(400).send({ error: 'from must be an account id' });
    return moveCandidates(db, from!);
  });

  // {fromAccountId, toAccountId (null = cancel), seriesIds: [...], marked?: true = already done}
  app.post('/api/charge-moves', async (req, reply) => {
    const b = (req.body ?? {}) as { fromAccountId?: unknown; toAccountId?: unknown; seriesIds?: unknown; marked?: unknown };
    if (!accountExists(db, b.fromAccountId)) return reply.code(400).send({ error: 'fromAccountId must be an account id' });
    const to = b.toAccountId == null || b.toAccountId === '' ? null : b.toAccountId;
    if (to != null && (!accountExists(db, to) || to === b.fromAccountId)) return reply.code(400).send({ error: 'toAccountId must be another account (or null to cancel)' });
    const ids = Array.isArray(b.seriesIds) ? b.seriesIds.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) return reply.code(400).send({ error: 'seriesIds is required' });
    const created = addChargeMoves(db, b.fromAccountId as string, to as string | null, ids, { marked: b.marked === true });
    // something cancelled / moved earlier may already be visible in the rows
    if (b.marked === true) verifyChargeMoves(db);
    return { created: created.length, moves: listChargeMoves(db) };
  });

  // {status: "moved"} = done (from today; again after a failure too), {status: "todo"} = not yet; {notes}
  app.patch('/api/charge-moves/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!db.prepare(`SELECT 1 FROM charge_moves WHERE id = ?`).get(id)) return reply.code(404).send({ error: 'not found' });
    const b = (req.body ?? {}) as { status?: unknown; notes?: unknown };
    if (b.status !== undefined) {
      if (b.status !== 'moved' && b.status !== 'todo') return reply.code(400).send({ error: 'status must be moved or todo' });
      markChargeMove(db, id, b.status);
    }
    if (b.notes !== undefined) db.prepare(`UPDATE charge_moves SET notes = ? WHERE id = ?`).run(b.notes ? String(b.notes) : null, id);
    return listChargeMoves(db).find(m => m.id === id);
  });

  app.delete('/api/charge-moves/:id', async req => {
    db.prepare(`DELETE FROM charge_moves WHERE id = ?`).run(Number((req.params as { id: string }).id));
    return { ok: true };
  });
}
