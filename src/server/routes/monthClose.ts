import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { answerCheck, closeHistory, closeMonth, monthCloseState, monthReport, reopenMonth } from '../../analytics/monthClose.js';
import { today } from '../../analytics/common.js';

const CYCLE = /^\d{4}-\d{2}$/;
const ANSWERS = ['ok', 'ended', 'later', 'other'];

export function monthCloseRoutes(app: FastifyInstance, db: DB): void {
  // the checks of a month (default: the last one that ended) and the close status of the last 12
  app.get('/api/month-close', async (req, reply) => {
    const cycle = (req.query as { cycle?: string }).cycle;
    if (cycle && !CYCLE.test(cycle)) return reply.code(400).send({ error: 'cycle must be YYYY-MM' });
    return { history: closeHistory(db), state: monthCloseState(db, cycle || undefined) };
  });

  // an answer to one check: ok (it's fine) | ended | later | other (fixed items); null removes it
  app.put('/api/month-close/:cycle/checks', async (req, reply) => {
    const { cycle } = req.params as { cycle: string };
    const b = (req.body ?? {}) as { checkId?: unknown; answer?: unknown };
    const checkId = String(b.checkId ?? '');
    const answer = b.answer == null ? null : String(b.answer);
    if (!CYCLE.test(cycle) || !checkId) return reply.code(400).send({ error: 'cycle and checkId are required' });
    if (answer && !ANSWERS.includes(answer)) return reply.code(400).send({ error: `answer must be one of ${ANSWERS.join(', ')}` });
    answerCheck(db, cycle, checkId, answer);
    return monthCloseState(db, cycle);
  });

  app.post('/api/month-close/:cycle', async (req, reply) => {
    const { cycle } = req.params as { cycle: string };
    if (!CYCLE.test(cycle)) return reply.code(400).send({ error: 'cycle must be YYYY-MM' });
    if (monthCloseState(db, cycle).open) return reply.code(400).send({ error: 'החודש עוד לא נגמר' });
    closeMonth(db, cycle);
    return monthCloseState(db, cycle);
  });

  app.delete('/api/month-close/:cycle', async req => {
    reopenMonth(db, (req.params as { cycle: string }).cycle);
    return { ok: true };
  });

  app.get('/api/month-report', async (req, reply) => {
    const cycle = (req.query as { cycle?: string }).cycle;
    if (cycle && !CYCLE.test(cycle)) return reply.code(400).send({ error: 'cycle must be YYYY-MM' });
    return monthReport(db, cycle || undefined, today());
  });
}
