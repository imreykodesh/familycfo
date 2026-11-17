import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { healthReport, setIgnored } from '../../analytics/health.js';

export function healthRoutes(app: FastifyInstance, db: DB): void {
  // every check in one list (src/analytics/health.ts); `problems` is the number on the menu
  app.get('/api/health', async () => healthReport(db));

  // {id, ignore: true} hides the row as it reads now (it comes back when it changes); {id, ignore: false} shows it again
  app.put('/api/health/ignore', async (req, reply) => {
    const b = (req.body ?? {}) as { id?: unknown; ignore?: unknown };
    const id = typeof b.id === 'string' ? b.id : '';
    if (!id) return reply.code(400).send({ error: 'id is required' });
    if (!setIgnored(db, id, b.ignore !== false)) return reply.code(404).send({ error: 'אין בדיקה כזו, או שהיא כבר בסדר' });
    return healthReport(db);
  });
}
