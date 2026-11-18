import type { DB } from '../db/connection.js';
import { categorize } from '../categorizer.js';
import { merchantKey } from '../analytics/common.js';
import { SCRAPER_CATEGORY_MAP } from './scraperCategories.js';
import { keywordCategoryNames, normalizeDescription } from './keywordCategories.js';

// JS `\b` only knows ASCII word characters, so Hebrew words need an explicit end-of-word lookahead
const WORD_END = `(?=$|[\\s\\-–'"״׳])`;

/** Bank-account rows that pay a credit-card bill (the purchases are already stored per card). */
export const CARD_PAYMENT_PATTERN = new RegExp(
  `^(ויזה|כאל|ישראכרט|מקס|לאומי קארד|לאומיקארד|לאומי מאסטרקרד|מאסטרקרד|אמריקן אקספרס|דיינרס|max|visa|isracard|cal)${WORD_END}`, 'i');

/** Standing orders into savings plans / deposits. */
export const SAVINGS_PATTERN = /לחיסכון|לחסכון|פיקדון|פקדון|קופת גמל|השקעה ב/;

export interface Rule {
  id: number;
  match_type: 'exact' | 'contains';
  pattern: string;
  account_id: string | null;
  min_amount: number | null;
  max_amount: number | null;
  set_category_id: number | null;
  set_business_id: number | null;
  set_business_share_pct: number | null;
  set_member_id: number | null;
  set_kind: string | null;
  set_tag_ids: string | null;
  priority: number;
}

interface TxRow {
  id: number;
  account_id: string;
  description: string;
  charged_amount: number;
  source_category: string | null;
  category_id: number | null;
  category_source: string | null;
  kind_source: string | null;
}

export function ruleMatches(rule: Rule, tx: Pick<TxRow, 'description' | 'account_id' | 'charged_amount'>): boolean {
  const desc = tx.description.trim().toLowerCase();
  const pattern = rule.pattern.trim().toLowerCase();
  // patterns saved from "apply to similar" are merchant keys (no punctuation or codes), so compare both forms
  const key = merchantKey(desc);
  if (rule.match_type === 'exact' ? desc !== pattern && key !== pattern : !desc.includes(pattern) && !key.includes(pattern)) return false;
  if (rule.account_id && rule.account_id !== tx.account_id) return false;
  const amount = Math.abs(tx.charged_amount);
  if (rule.min_amount != null && amount < rule.min_amount) return false;
  if (rule.max_amount != null && amount > rule.max_amount) return false;
  return true;
}

export function loadRules(db: DB): Rule[] {
  return db.prepare(`SELECT * FROM category_rules ORDER BY priority DESC, id DESC`).all() as Rule[];
}

/**
 * Apply rules to transactions. Fields the user edited by hand (category_source / kind_source
 * = 'manual') are left alone. Returns the ids that changed.
 */
export function applyRules(db: DB, txIds: number[] | 'all', rules = loadRules(db)): number[] {
  if (!rules.length) return [];
  const rows = (txIds === 'all'
    ? db.prepare(`SELECT * FROM transactions`).all()
    : txIds.map(id => db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id)).filter(Boolean)
  ) as (TxRow & { business_id: number | null; member_id: number | null })[];

  const setCategory = db.prepare(`UPDATE transactions SET category_id = ?, category_source = 'rule' WHERE id = ?`);
  const setKind = db.prepare(`UPDATE transactions SET kind = ?, kind_source = 'rule' WHERE id = ?`);
  const setBusiness = db.prepare(`UPDATE transactions SET business_id = ?, business_share_pct = ? WHERE id = ?`);
  const setMember = db.prepare(`UPDATE transactions SET member_id = ? WHERE id = ?`);
  const addTag = db.prepare(`INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)`);
  const changed: number[] = [];

  db.transaction(() => {
    for (const tx of rows) {
      const rule = rules.find(r => ruleMatches(r, tx));
      if (!rule) continue;
      if (rule.set_category_id && tx.category_source !== 'manual') setCategory.run(rule.set_category_id, tx.id);
      if (rule.set_kind && tx.kind_source !== 'manual') setKind.run(rule.set_kind, tx.id);
      if (rule.set_business_id && tx.business_id == null) {
        setBusiness.run(rule.set_business_id, rule.set_business_share_pct ?? 100, tx.id);
      }
      if (rule.set_member_id && tx.member_id == null) setMember.run(rule.set_member_id, tx.id);
      for (const tagId of JSON.parse(rule.set_tag_ids || '[]') as number[]) addTag.run(tx.id, tagId);
      changed.push(tx.id);
    }
  })();
  return changed;
}

/** A category by name, following aliases left by renames and merges. */
export function findCategory(db: DB, name: string): number | undefined {
  return (db.prepare(`SELECT id FROM categories WHERE name = ?`).pluck().get(name)
    ?? db.prepare(`SELECT category_id FROM category_aliases WHERE name = ?`).pluck().get(name)) as number | undefined;
}

export function getOrCreateCategory(db: DB, name: string): number {
  const existing = findCategory(db, name);
  if (existing) return existing;
  const kind = name.startsWith('הכנסה') ? 'income' : 'expense';
  return Number(db.prepare(`INSERT INTO categories (name, kind) VALUES (?, ?)`).run(name, kind).lastInsertRowid);
}

/**
 * The category for a card company's own category name: a category with that name (or an alias left
 * by a rename / merge) → the existing category it means (`SCRAPER_CATEGORY_MAP`). Never creates a
 * category (that would duplicate the household's own tree); no match = the row stays uncategorized.
 */
export function scraperCategory(db: DB, sourceCategory: string): number | undefined {
  const name = sourceCategory.trim();
  if (!name) return undefined;
  const mapped = SCRAPER_CATEGORY_MAP[name];
  return findCategory(db, name) ?? (mapped ? findCategory(db, mapped) : undefined);
}

/**
 * The same merchant written a little differently: lower case, no punctuation, digits removed from
 * every word (reference numbers, branch codes, "HAIM4723" → "haim"). Empty when nothing is left.
 */
export function similarKey(description: string): string {
  return normalizeDescription(description)
    .split(' ')
    .map(w => w.replace(/\p{N}+/gu, ''))
    .filter(Boolean)
    .join(' ');
}

/**
 * Whether a category of this kind fits the row's direction: income categories take money in,
 * expense categories money out (or a refund on a card). Transfer / savings / card-bill categories
 * go either way (the keyword index has none that could turn spend into a transfer).
 */
export function categoryFits(categoryKind: string | null, amount: number, accountKind: string | null): boolean {
  switch (categoryKind ?? 'expense') {
    case 'income': return amount > 0;
    case 'expense': return amount < 0 || (amount > 0 && accountKind === 'card');
    default: return true;
  }
}

/** The household's category for the built-in keyword index (`KEYWORD_CATEGORIES`), if one fits the row. */
export function keywordCategory(db: DB, description: string, amount: number, accountKind: string | null): number | undefined {
  for (const name of keywordCategoryNames(description)) {
    const id = findCategory(db, name);
    if (!id) continue;
    const kind = db.prepare(`SELECT kind FROM categories WHERE id = ?`).pluck().get(id) as string | null;
    if (categoryFits(kind, amount, accountKind)) return id;
  }
  return undefined;
}

/**
 * Fill in categories for uncategorized rows: rules → same-description cache → the same merchant
 * written differently (`similarKey`) → the built-in keyword index → the scraper's own category
 * (`scraperCategory`) → the external categorization API.
 */
export async function categorizeTransactions(db: DB, txIds: number[], apiUrl?: string): Promise<void> {
  applyRules(db, txIds);

  const cache = db.prepare(`
    SELECT category_id FROM transactions
    WHERE description = ? AND category_id IS NOT NULL AND id != ?
    ORDER BY CASE category_source WHEN 'manual' THEN 0 WHEN 'rule' THEN 1 ELSE 2 END, id DESC
    LIMIT 1
  `).pluck();
  const set = db.prepare(`UPDATE transactions SET category_id = ?, category_source = ? WHERE id = ?`);
  const accountKind = db.prepare(`SELECT kind FROM accounts WHERE id = ?`).pluck();
  const categoryKind = db.prepare(`SELECT kind FROM categories WHERE id = ?`).pluck();
  const apiCache = new Map<string, number | null>();

  // similar key → category, from rows already categorized (by hand first, then rules, then the newest)
  const similar = new Map<string, number>();
  if (txIds.length) {
    const known = db.prepare(`
      SELECT description, category_id FROM transactions WHERE category_id IS NOT NULL
      ORDER BY CASE category_source WHEN 'manual' THEN 2 WHEN 'rule' THEN 1 ELSE 0 END, id
    `).all() as { description: string; category_id: number }[];
    for (const r of known) { const key = similarKey(r.description); if (key.length >= 3) similar.set(key, r.category_id); }
  }

  for (const id of txIds) {
    const tx = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id) as TxRow | undefined;
    // a row the user left without a category on purpose stays that way
    if (!tx || tx.category_id != null || tx.category_source === 'manual') continue;
    const key = similarKey(tx.description);
    const found = (categoryId: number, source: string) => {
      set.run(categoryId, source, tx.id);
      if (key.length >= 3 && !similar.has(key)) similar.set(key, categoryId);
    };

    const kindOfAccount = accountKind.get(tx.account_id) as string | null;
    // the same description in the other direction (a loan charge and its credit) isn't the same category
    const cached = cache.get(tx.description, tx.id) as number | undefined;
    if (cached && categoryFits(categoryKind.get(cached) as string | null, tx.charged_amount, kindOfAccount)) { found(cached, 'cache'); continue; }

    const alike = key.length >= 3 ? similar.get(key) : undefined;
    if (alike && categoryFits(categoryKind.get(alike) as string | null, tx.charged_amount, kindOfAccount)) { found(alike, 'cache'); continue; }

    const fromKeywords = keywordCategory(db, tx.description, tx.charged_amount, kindOfAccount);
    if (fromKeywords) { found(fromKeywords, 'keyword'); continue; }

    const fromScraper = tx.source_category ? scraperCategory(db, tx.source_category) : undefined;
    if (fromScraper) { found(fromScraper, 'scraper'); continue; }

    if (!apiUrl) continue;
    if (!apiCache.has(tx.description)) {
      const name = await categorize(tx.description, apiUrl);
      // only categories that exist (or old names aliased to one) — an unknown answer stays uncategorized
      const id = name ? findCategory(db, name) ?? null : null;
      if (name && !id) console.warn(`Categorizer answered an unknown category "${name}" for "${tx.description}"`);
      apiCache.set(tx.description, id);
    }
    const categoryId = apiCache.get(tx.description);
    if (categoryId) set.run(categoryId, 'api', tx.id);
  }
}

/**
 * Derive each row's kind (expense / income / refund / transfer / card_payment / savings)
 * unless a rule or the user set it. Card-bill rows on bank accounts become card_payment so
 * card purchases aren't counted twice.
 */
export function deriveKinds(db: DB, txIds: number[] | 'all'): void {
  const where = txIds === 'all' ? '' : `AND t.id IN (${txIds.map(Number).join(',') || 'NULL'})`;
  const rows = db.prepare(`
    SELECT t.id, t.description, t.charged_amount, a.kind AS account_kind, c.kind AS category_kind
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE COALESCE(t.kind_source, 'auto') = 'auto' ${where}
  `).all() as { id: number; description: string; charged_amount: number; account_kind: string; category_kind: string | null }[];

  const update = db.prepare(`UPDATE transactions SET kind = ?, kind_source = 'auto' WHERE id = ?`);
  db.transaction(() => {
    for (const r of rows) update.run(kindFor(r), r.id);
  })();
}

export function kindFor(r: { description: string; charged_amount: number; account_kind: string; category_kind: string | null }): string {
  if (r.account_kind === 'bank' && r.charged_amount < 0 && CARD_PAYMENT_PATTERN.test(r.description.trim())) {
    return 'card_payment';
  }
  if (r.category_kind === 'card_payment' && r.account_kind === 'bank') return 'card_payment';
  if (r.account_kind === 'bank' && r.charged_amount < 0 && SAVINGS_PATTERN.test(r.description)) return 'savings';
  if (r.category_kind === 'transfer' || r.category_kind === 'savings') return r.category_kind;
  if (r.charged_amount > 0) {
    return r.category_kind === 'income' || r.account_kind === 'bank' ? 'income' : 'refund';
  }
  return 'expense';
}
