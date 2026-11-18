import { getDb, type DB } from './db/connection.js';
import { categorizeTransactions, deriveKinds } from './ingest/classify.js';
import { matchImmediateCardDebits, matchInternalTransfers, reconcileCardBills } from './ingest/transfers.js';
import { refreshRecurring } from './analytics/recurring.js';
import { suggestScheduledItems } from './analytics/scheduled.js';
import { suggestPaybacks } from './analytics/paybacks.js';
import { refreshAlerts } from './analytics/alerts.js';
import { refreshBoiRates } from './analytics/fx.js';
import { refreshHistory, refreshQuotes } from './analytics/quotes.js';
import { matchPlanned } from './analytics/planned.js';
import { verifyChargeMoves } from './analytics/chargeMoves.js';
import { fireDueReminders } from './analytics/reminders.js';

export interface PipelineOptions {
  /** rows to categorize; defaults to every uncategorized row */
  txIds?: number[];
  categoryApiUrl?: string;
  fetchRates?: boolean;
}

/** Everything that runs after a scrape: classify → kinds/transfers → recurring → suggestions → alerts. */
export async function runPipeline(db: DB = getDb(), opts: PipelineOptions = {}): Promise<Record<string, number>> {
  // the given rows (these may go to the external API), plus every older uncategorized row: a new rule,
  // a row categorized by hand or a new keyword may fit it now (no API call for those)
  const uncategorized = db.prepare(`SELECT id FROM transactions
    WHERE category_id IS NULL AND COALESCE(category_source, '') != 'manual'`).pluck().all() as number[];
  const ids = opts.txIds ?? uncategorized;
  const given = new Set(opts.txIds ?? uncategorized);
  const older = uncategorized.filter(id => !given.has(id));

  if (opts.fetchRates !== false) {
    try { await refreshBoiRates(db); } catch (err) { console.warn('  FX rates not refreshed:', (err as Error).message); }
    try { await refreshQuotes(db, 0); await refreshHistory(db); } catch (err) { console.warn('  stock prices not refreshed:', (err as Error).message); }
  }
  await categorizeTransactions(db, ids, opts.categoryApiUrl);
  await categorizeTransactions(db, older);
  deriveKinds(db, 'all');
  const cardBills = reconcileCardBills(db);
  const debits = matchImmediateCardDebits(db);
  const transfers = matchInternalTransfers(db);
  // planned expenses whose real row arrived: link them (they stop counting, the real row counts)
  const planned = matchPlanned(db);
  const recurring = refreshRecurring(db).length;
  // charges the user moved to another card / cancelled: arrived on the new one? charged again on the old one?
  const moves = verifyChargeMoves(db);
  const scheduled = suggestScheduledItems(db);
  const paybacks = suggestPaybacks(db);
  const alerts = refreshAlerts(db) + fireDueReminders(db);
  return { categorized: ids.length, cardBillsKept: cardBills.kept, cardBillsDemoted: cardBills.demoted, immediateDebits: debits.matched, debitCards: debits.debitCards.length, transfers, plannedMatched: planned.matched, plannedAmbiguous: planned.ambiguous, recurring, movesVerified: moves.verified, movesFailed: moves.failed, scheduled, paybacks, alerts };
}

// `npm run pipeline` — reprocess the database without scraping (set CATEGORY_API_URL to categorize via the API)
if (import.meta.url === `file://${process.argv[1]}`) {
  const summary = await runPipeline(getDb(), { categoryApiUrl: process.env.CATEGORY_API_URL });
  console.log('Pipeline:', summary);
}
