import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { autoReminders, fireDueReminders, isReminderTime, listReminders, nowLocal, type Repeat } from '../../analytics/reminders.js';

const REPEATS: Repeat[] = ['once', 'monthly', 'yearly'];
type Body = { text?: unknown; at?: unknown; repeat?: unknown; href?: unknown; done?: unknown };

/** A screen path inside the app (the notification opens it): "/…", no scheme or host. */
const isHref = (v: unknown) => v == null || v === '' || (typeof v === 'string' && /^\/(?!\/)[^\s]*$/.test(v) && v.length <= 200);

function report(db: DB) {
  return { reminders: listReminders(db), auto: autoReminders(db), now: nowLocal() };
}

export function reminderRoutes(app: FastifyInstance, db: DB): void {
  app.get('/api/reminders', async () => report(db));

  // {text, at: "YYYY-MM-DDTHH:MM" (Israel time), repeat?: once | monthly | yearly, href?: "/screen"}
  app.post('/api/reminders', async (req, reply) => {
    const b = (req.body ?? {}) as Body;
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    const repeat = (b.repeat ?? 'once') as Repeat;
    if (!text) return reply.code(400).send({ error: 'צריך טקסט לתזכורת' });
    if (!isReminderTime(b.at)) return reply.code(400).send({ error: 'at must be YYYY-MM-DDTHH:MM' });
    if (!REPEATS.includes(repeat)) return reply.code(400).send({ error: 'repeat must be once, monthly or yearly' });
    if (!isHref(b.href)) return reply.code(400).send({ error: 'href must be a screen path like /insurance' });
    db.prepare(`INSERT INTO reminders (text, start_at, repeat, href) VALUES (?, ?, ?, ?)`).run(text, b.at, repeat, (b.href as string) || null);
    return report(db);
  });

  // the same fields, and done: true (stop) / false (start again)
  app.patch('/api/reminders/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!db.prepare(`SELECT 1 FROM reminders WHERE id = ?`).get(id)) return reply.code(404).send({ error: 'not found' });
    const b = (req.body ?? {}) as Body;
    const cols: Record<string, unknown> = {};
    if (b.text !== undefined) { const t = typeof b.text === 'string' ? b.text.trim() : ''; if (!t) return reply.code(400).send({ error: 'צריך טקסט לתזכורת' }); cols.text = t; }
    if (b.at !== undefined) {
      if (!isReminderTime(b.at)) return reply.code(400).send({ error: 'at must be YYYY-MM-DDTHH:MM' });
      // a new time starts over: it fires again from that time
      Object.assign(cols, { start_at: b.at, last_fired_at: null, done_at: null });
    }
    if (b.repeat !== undefined) { if (!REPEATS.includes(b.repeat as Repeat)) return reply.code(400).send({ error: 'repeat must be once, monthly or yearly' }); cols.repeat = b.repeat; }
    if (b.href !== undefined) { if (!isHref(b.href)) return reply.code(400).send({ error: 'href must be a screen path' }); cols.href = b.href || null; }
    if (b.done !== undefined) cols.done_at = b.done ? nowLocal() : null;
    const keys = Object.keys(cols);
    if (keys.length) db.prepare(`UPDATE reminders SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @__id`).run({ ...cols, __id: id });
    fireDueReminders(db);
    return report(db);
  });

  app.delete('/api/reminders/:id', async req => {
    db.prepare(`DELETE FROM reminders WHERE id = ?`).run(Number((req.params as { id: string }).id));
    return report(db);
  });
}
