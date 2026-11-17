import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { maaserConfig, maaserReport, parseMaaserConfig, saveMaaserConfig } from '../../analytics/maaser.js';

export function maaserRoutes(app: FastifyInstance, db: DB): void {
  // month by month: income counted, required, given, running balance (src/analytics/maaser.ts)
  app.get('/api/maaser', async () => maaserReport(db));

  // any of the MaaserConfig fields; the rest stay as they are
  app.put('/api/maaser/config', async (req, reply) => {
    const next = parseMaaserConfig((req.body ?? {}) as Record<string, unknown>, maaserConfig(db));
    if (typeof next === 'string') return reply.code(400).send({ error: next });
    saveMaaserConfig(db, next);
    return maaserReport(db);
  });
}
