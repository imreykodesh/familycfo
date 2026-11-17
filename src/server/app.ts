import Fastify, { type FastifyInstance } from 'fastify';
import { getDb, type DB } from '../db/connection.js';
import { registerCrud, toApi } from './crud.js';
import { transactionRoutes } from './routes/transactions.js';
import { analyticsRoutes } from './routes/analytics.js';
import { eventRoutes } from './routes/events.js';
import { categoryRoutes } from './routes/categories.js';
import { AGENT_PROVIDERS, agentRoutes } from './agent.js';
import { MODEL_SETTING_KEYS, agentSetupRoutes, isModelId } from './agentSetup.js';
import { insuranceRoutes } from './routes/insurance.js';
import { pensionRoutes } from './routes/pension.js';
import { reportRoutes } from './routes/reports.js';
import { investmentRoutes } from './routes/investments.js';
import { seasonalRoutes } from './routes/seasonal.js';
import { monthCloseRoutes } from './routes/monthClose.js';
import { simulatorRoutes } from './routes/simulator.js';
import { healthRoutes } from './routes/health.js';
import { chargeMoveRoutes } from './routes/chargeMoves.js';
import { maaserRoutes } from './routes/maaser.js';
import { iouRoutes } from './routes/iou.js';
import { setRate } from '../analytics/fx.js';

import { localOnly, serveWeb } from './web.js';
import { emitAppEvent } from './appEvents.js';
import { MAX_MONTHS_BACK } from '../scraper.js';
import { installFileLog, serverLogStream } from '../log.js';

// Local-only: this API exposes the household's full financial data and has no login
const HOST = '127.0.0.1';

export interface ServerOptions {
  /** default PORT ?? 4310; 0 = any free port */
  port?: number;
  /** also serve the built web UI (web/dist) from this port — the desktop app has no Vite */
  webDist?: string;
}

export function buildApp(db: DB, opts: Pick<ServerOptions, 'webDist'> = {}): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn', stream: serverLogStream } });
  localOnly(app);

  registerCrud(app, db, { table: 'members', path: 'members', columns: ['name', 'color'], allowDelete: false });
  registerCrud(app, db, {
    table: 'accounts', path: 'accounts', idType: 'text', allowCreate: false, allowDelete: false,
    columns: ['displayName', 'ownerMemberId', 'billingBankAccountId', 'active'], orderBy: 'kind, id',
  });
  registerCrud(app, db, { table: 'businesses', path: 'businesses', columns: ['name', 'color', 'archived'], orderBy: 'name' });
  registerCrud(app, db, { table: 'tags', path: 'tags', columns: ['name', 'color', 'startDate', 'endDate', 'budget', 'notes', 'archived'], orderBy: 'name' });
  registerCrud(app, db, { table: 'sinking_funds', path: 'funds', columns: ['name', 'monthlyTarget', 'balance', 'goalAmount', 'goalDate'] });
  registerCrud(app, db, {
    table: 'assets', path: 'assets', orderBy: 'type, name',
    columns: ['name', 'type', 'provider', 'ownerMemberId', 'currency', 'liquidityDate', 'managementFee', 'monthlyDeposit', 'notes', 'archived'],
  });
  registerCrud(app, db, { table: 'asset_snapshots', path: 'asset-snapshots', columns: ['assetId', 'date', 'value', 'currency'], orderBy: 'date DESC' });
  registerCrud(app, db, {
    table: 'liabilities', path: 'liabilities', orderBy: 'type, name',
    columns: ['name', 'type', 'lender', 'ownerMemberId', 'originalPrincipal', 'interestRate', 'indexType', 'startDate',
      'endDate', 'monthlyPayment', 'paymentDay', 'bankAccountId', 'matchPattern', 'notes', 'archived'],
  });
  registerCrud(app, db, { table: 'liability_snapshots', path: 'liability-snapshots', columns: ['liabilityId', 'date', 'balance'], orderBy: 'date DESC' });
  registerCrud(app, db, {
    table: 'scheduled_items', path: 'scheduled', orderBy: 'day_of_month, name',
    columns: ['name', 'kind', 'amount', 'amountMode', 'dayOfMonth', 'bankAccountId', 'memberId', 'categoryId', 'matchPattern',
      'liabilityId', 'cardAccountId', 'startDate', 'endDate', 'status'],
  });

  app.get('/api/meta', async () => ({
    members: (db.prepare(`SELECT * FROM members ORDER BY id`).all() as Record<string, unknown>[]).map(toApi),
    accounts: (db.prepare(`SELECT * FROM accounts ORDER BY kind, id`).all() as Record<string, unknown>[]).map(toApi),
    categories: (db.prepare(`SELECT * FROM categories ORDER BY name`).all() as Record<string, unknown>[]).map(toApi),
    businesses: (db.prepare(`SELECT * FROM businesses ORDER BY name`).all() as Record<string, unknown>[]).map(toApi),
    tags: (db.prepare(`SELECT * FROM tags ORDER BY name`).all() as Record<string, unknown>[]).map(toApi),
    funds: (db.prepare(`SELECT * FROM sinking_funds ORDER BY id`).all() as Record<string, unknown>[]).map(toApi),
    settings: Object.fromEntries((db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[]).map(s => [s.key, s.value])),
  }));

  app.put('/api/settings', async (req, reply) => {
    const body = req.body as Record<string, string | number>;
    const allowed = ['cycle_start_day', 'balance_buffer', 'category_api_url', 'scrape_months_back', 'agent_provider', ...MODEL_SETTING_KEYS,
      // the desktop app: daily scrape and notifications
      'scrape_time', 'scrape_catch_up', 'notify_scrape', 'notify_alerts', 'onboarding_done'];
    if (body.scrape_time != null && !/^(([01]?\d|2[0-3]):[0-5]\d)?$/.test(String(body.scrape_time))) {
      return reply.code(400).send({ error: 'scrape_time must be HH:MM' });
    }
    if (body.agent_provider != null && !(AGENT_PROVIDERS as readonly string[]).includes(String(body.agent_provider))) {
      return reply.code(400).send({ error: `agent_provider must be one of ${AGENT_PROVIDERS.join(', ')}` });
    }
    for (const k of MODEL_SETTING_KEYS) {
      if (body[k] != null && !isModelId(String(body[k]))) return reply.code(400).send({ error: `bad model id for ${k}` });
    }
    const months = body.scrape_months_back;
    if (months != null && !(Number.isInteger(Number(months)) && Number(months) >= 1 && Number(months) <= MAX_MONTHS_BACK)) {
      return reply.code(400).send({ error: `מספר החודשים לעדכון צריך להיות בין 1 ל-${MAX_MONTHS_BACK}` });
    }
    const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    const changed = Object.keys(body).filter(k => allowed.includes(k));
    for (const k of changed) upsert.run(k, String(body[k]));
    if (changed.length) emitAppEvent({ type: 'settings', keys: changed });
    return { ok: true };
  });

  app.get('/api/fx', async () => db.prepare(`
    SELECT currency, rate_to_ils, date, source FROM fx_rates f
    WHERE date = (SELECT MAX(date) FROM fx_rates WHERE currency = f.currency) ORDER BY currency
  `).all());
  app.put('/api/fx', async req => {
    const b = req.body as { currency: string; rate: number; date?: string };
    setRate(db, b.date ?? new Date().toISOString().slice(0, 10), b.currency, b.rate);
    return { ok: true };
  });

  transactionRoutes(app, db);
  analyticsRoutes(app, db);
  eventRoutes(app, db);
  categoryRoutes(app, db);
  agentRoutes(app, db);
  agentSetupRoutes(app);
  insuranceRoutes(app, db);
  pensionRoutes(app, db);
  reportRoutes(app, db);
  investmentRoutes(app, db);
  seasonalRoutes(app, db);
  monthCloseRoutes(app, db);
  simulatorRoutes(app, db);
  healthRoutes(app, db);
  chargeMoveRoutes(app, db);
  maaserRoutes(app, db);
  iouRoutes(app, db);

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    app.log.error(err);
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  if (opts.webDist) serveWeb(app, opts.webDist);
  return app;
}

/** Start the API (and, with webDist, the UI) on 127.0.0.1. Resolves with the app and the port it listens on. */
export async function startServer(opts: ServerOptions = {}): Promise<{ app: FastifyInstance; port: number }> {
  installFileLog('server');
  const app = buildApp(getDb(), opts);
  await app.listen({ host: HOST, port: opts.port ?? Number(process.env.PORT ?? 4310) });
  const address = app.server.address();
  return { app, port: typeof address === 'object' && address ? address.port : Number(opts.port) };
}
