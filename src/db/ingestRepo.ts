import type { DB } from './connection.js';
import { BANK_COMPANIES, friendlyAccountName } from './migrations.js';
import { dateKey, localDate, normalizeTransactions, type NormalizedTransaction, type ScrapedAccount } from '../ingest/normalize.js';

export interface SaveResult {
  insertedIds: number[];
  updated: number;
  /** pending rows the company no longer reports */
  removed: number;
}

/**
 * Store one scraped account: upsert the account, record its balance and insert/update
 * its transactions. User-owned fields (category, member, business, tags, notes...) are
 * never overwritten here — only data that comes from the bank.
 */
export function saveScrapedAccount(db: DB, companyId: string, account: ScrapedAccount): SaveResult & { accountId: string } {
  const accountId = `${companyId}:${account.accountNumber}`;

  db.prepare(`
    INSERT INTO accounts (id, company, kind, display_name, card_frame, currency, is_savings, last_scraped_at)
    VALUES (@id, @company, @kind, @displayName, @cardFrame, @currency, @isSavings, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      card_frame = COALESCE(excluded.card_frame, accounts.card_frame),
      currency = excluded.currency,
      is_savings = MAX(accounts.is_savings, excluded.is_savings),
      last_scraped_at = CURRENT_TIMESTAMP,
      active = 1
  `).run({
    id: accountId,
    company: companyId,
    kind: BANK_COMPANIES.has(companyId) ? 'bank' : 'card',
    displayName: friendlyAccountName(accountId),
    cardFrame: account.cardFrame ?? null,
    currency: account.currency ?? 'ILS',
    isSavings: account.savingsAccount ? 1 : 0,
  });

  const balance = account.balance
    ?? (account as { info?: { futureChargesTotal?: number } }).info?.futureChargesTotal ?? 0;
  // some scrapers (Mizrahi) sometimes return NaN / a non-number: keep the last known balance instead of failing the scrape
  if (typeof balance === 'number' && Number.isFinite(balance)) {
    db.prepare(`INSERT INTO balances (account_id, balance) VALUES (?, ?)`).run(accountId, balance);
  } else {
    console.warn(`  ${accountId}: the bank returned no valid balance (${String(balance)}); keeping the last one`);
  }

  const result = saveTransactions(db, normalizeTransactions(accountId, account.txns ?? []));
  return { accountId, ...result };
}

export function saveTransactions(db: DB, txns: NormalizedTransaction[]): SaveResult {
  const byIdentifier = db.prepare(`SELECT id FROM transactions WHERE identifier = ?`).pluck();
  const legacyMatch = db.prepare(
    `SELECT id FROM transactions WHERE identifier = ? AND bank_identifier IS NULL`
  ).pluck();
  // A pending row that has since completed (completed rows get a reference and a charged amount).
  // Compared by the Israel calendar day: Max dates a pending row with its time (2026-11-13T11:14Z) and the
  // completed one at local midnight (2026-11-12T22:00Z), so the ISO prefixes differ.
  const pendingCandidates = db.prepare(`
    SELECT id, date FROM transactions
    WHERE account_id = ? AND description = ? AND original_amount = ?
      AND (status = 'pending' OR (status IS NULL AND charged_amount = 0)) AND identifier != ?
    ORDER BY id
  `);
  const pendingMatch = (t: NormalizedTransaction): number | undefined => {
    const day = localDate(t.date);
    const rows = pendingCandidates.all(t.accountId, t.description, t.originalAmount, t.identifier) as { id: number; date: string }[];
    return rows.find(r => !claimed.has(r.id) && localDate(r.date) === day)?.id;
  };
  const pendingRows = db.prepare(`SELECT id, date FROM transactions WHERE account_id = ? AND status = 'pending'`);
  const deleteRow = db.prepare(`DELETE FROM transactions WHERE id = ?`);

  // Same transaction, different reference: some banks (Hapoalim) renumber the reference between scrapes.
  // Candidates are matched one-to-one, so two identical coffees on the same day stay two rows.
  const sameRow = db.prepare(`
    SELECT id, identifier FROM transactions
    WHERE account_id = ? AND substr(date, 1, 10) = ? AND description = ? AND charged_amount = ?
      AND COALESCE(installment_number, 0) = ?
    ORDER BY id
  `);

  const updateBankFields = db.prepare(`
    UPDATE transactions SET
      identifier = @identifier, date = @date, processed_date = @processedDate, memo = @memo,
      charged_amount = @chargedAmount, charged_currency = @chargedCurrency, status = @status,
      txn_type = @txnType, installment_number = @installmentNumber,
      installment_total = @installmentTotal, bank_identifier = @bankIdentifier,
      source_category = COALESCE(@sourceCategory, source_category),
      raw_json = COALESCE(@rawJson, raw_json), updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);
  const insert = db.prepare(`
    INSERT INTO transactions (identifier, account_id, date, processed_date, description, memo,
      original_amount, original_currency, charged_amount, charged_currency, status, txn_type,
      installment_number, installment_total, bank_identifier, source_category, raw_json)
    VALUES (@identifier, @accountId, @date, @processedDate, @description, @memo,
      @originalAmount, @originalCurrency, @chargedAmount, @chargedCurrency, @status, @txnType,
      @installmentNumber, @installmentTotal, @bankIdentifier, @sourceCategory, @rawJson)
  `);

  const insertedIds: number[] = [];
  let updated = 0;
  let removed = 0;

  const incoming = new Set(txns.map(t => t.identifier));
  const claimed = new Set<number>();
  const fuzzyMatch = (t: NormalizedTransaction): number | undefined => {
    const rows = sameRow.all(t.accountId, dateKey(t.date), t.description, t.chargedAmount, t.installmentNumber ?? 0) as { id: number; identifier: string }[];
    // skip rows another incoming transaction will match by its own identifier
    return rows.find(r => !claimed.has(r.id) && !incoming.has(r.identifier))?.id;
  };

  db.transaction(() => {
    for (const t of txns) {
      const existingId =
        (byIdentifier.get(t.identifier) as number | undefined) ??
        // rows saved before the migration carry the legacy identifier and no bank reference
        (t.bankIdentifier ? legacyMatch.get(t.legacyIdentifier) as number | undefined : undefined) ??
        (t.status !== 'pending' && t.chargedAmount !== 0 ? pendingMatch(t) : undefined) ??
        fuzzyMatch(t);
      if (existingId != null) claimed.add(existingId);

      if (existingId != null) {
        updateBankFields.run({ ...t, id: existingId });
        updated++;
      } else {
        const id = Number(insert.run(t).lastInsertRowid);
        claimed.add(id);
        insertedIds.push(id);
      }
    }

    // A pending authorization the company no longer reports (within the dates this scrape returned) was either
    // charged with a different amount / description or cancelled — the completed row, if any, is already saved.
    for (const accountId of new Set(txns.map(t => t.accountId))) {
      const from = txns.filter(t => t.accountId === accountId).map(t => localDate(t.date)).sort()[0];
      for (const r of pendingRows.all(accountId) as { id: number; date: string }[]) {
        if (!claimed.has(r.id) && localDate(r.date) >= from) { deleteRow.run(r.id); removed++; }
      }
    }
  })();

  return { insertedIds, updated, removed };
}

export function recordScrapeRun(db: DB, run: {
  company: string; startedAt: string; success: boolean;
  errorType?: string; errorMessage?: string; newTransactions?: number;
  /** a failed run: the bank page's URL and visible text when it closed */
  pageState?: string; startDate?: string;
}): void {
  db.prepare(`
    INSERT INTO scrape_runs (company, started_at, finished_at, success, error_type, error_message, new_transactions, page_state, start_date)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?)
  `).run(run.company, run.startedAt, run.success ? 1 : 0, run.errorType ?? null,
    run.errorMessage ?? null, run.newTransactions ?? 0, run.pageState ?? null, run.startDate ?? null);
}
