import type { DB } from '../db/connection.js';
import { COMPANY_NAMES, MANUAL_ACCOUNT_ID } from '../db/migrations.js';
import { latestBackup } from '../db/backup.js';
import { IN_DESKTOP } from '../paths.js';
import { explainScrapeError } from '../scrapeErrors.js';
import { localDate } from '../ingest/normalize.js';
import { addDays, daysBetween, getSetting, loadTransactions, today, type Tx } from './common.js';
import { findDuplicateCharges } from './alerts.js';
import { inferBillingAccounts } from './cards.js';
import { bankBalances } from './forecast.js';

/** problem = something is wrong or missing (counted on the menu); suggestion = worth a look; ok = checked and fine */
export type HealthStatus = 'problem' | 'suggestion' | 'ok';

/** A button the screen sends as is (always a path the API already has). */
export interface HealthAction {
  label: string;
  method: 'POST' | 'PATCH';
  path: string;
  body: Record<string, unknown>;
}

export interface HealthItem {
  id: string;
  kind: 'sync' | 'backup' | 'uncategorized' | 'duplicates' | 'gaps' | 'rule' | 'links' | 'planned' | 'billing' | 'stale';
  status: HealthStatus;
  title: string;
  detail?: string;
  /** the screen where it's fixed */
  href?: string;
  hrefLabel?: string;
  actions?: HealthAction[];
  /** the user chose "ignore" for exactly this wording; it comes back once the wording changes */
  ignored?: boolean;
}

export interface HealthReport {
  items: HealthItem[];
  /** problems not ignored — the number on the menu */
  problems: number;
  suggestions: number;
}

export interface HealthOptions {
  asOf?: string;
  /** the backup check only applies in the desktop app, which makes the backups */
  backups?: { enabled: boolean; dir?: string };
}

const ils = (n: number) => `₪${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
const dmy = (d: string) => d.slice(0, 10).split('-').reverse().join('.');
const companyName = (c: string) => COMPANY_NAMES[c] ?? c;
const monthLabel = (key: string) => `${key.slice(5, 7)}/${key.slice(0, 4)}`;
/** How "ignore" recognises the same row: its exact wording. */
export const wordingOf = (i: Pick<HealthItem, 'title' | 'detail'>) => `${i.title}\n${i.detail ?? ''}`;

const STALE_DAYS = 3;
const BACKUP_DAYS = 2;
const UNCATEGORIZED_PROBLEM_PCT = 5;
const RULE_MIN_MANUAL = 3;

/** 1. The last scrape of every company that has an active account: did it work, and how many failures in a row. */
function syncChecks(db: DB): HealthItem[] {
  const rows = db.prepare(`
    SELECT r.company, r.started_at, r.success, r.error_type, r.error_message, r.page_state,
      (SELECT MAX(started_at) FROM scrape_runs WHERE company = r.company AND success = 1) AS last_success,
      (SELECT COUNT(*) FROM scrape_runs f WHERE f.company = r.company AND f.success = 0
         AND f.id > COALESCE((SELECT MAX(id) FROM scrape_runs WHERE company = r.company AND success = 1), 0)) AS failures
    FROM scrape_runs r WHERE r.id = (SELECT MAX(id) FROM scrape_runs WHERE company = r.company)
      AND EXISTS (SELECT 1 FROM accounts a WHERE a.company = r.company AND a.active = 1)
    ORDER BY r.company
  `).all() as { company: string; started_at: string; success: number; error_type: string | null; error_message: string | null;
    page_state: string | null; last_success: string | null; failures: number }[];
  return rows.map(r => {
    const name = companyName(r.company);
    if (r.success) return { id: `sync:${r.company}`, kind: 'sync', status: 'ok', title: `המשיכה האחרונה מ${name} הצליחה` } as HealthItem;
    const why = explainScrapeError(r.error_type, r.error_message, r.page_state);
    return {
      id: `sync:${r.company}`, kind: 'sync', status: 'problem',
      title: r.failures > 1 ? `המשיכה מ${name} נכשלה ${r.failures} פעמים ברצף` : `המשיכה האחרונה מ${name} נכשלה`,
      detail: `${why.title}. ${why.hint}${r.last_success ? ` הצלחה אחרונה: ${dmy(localDate(r.last_success))}.` : ''}`,
      href: '/logs', hrefLabel: 'ליומן',
    } as HealthItem;
  });
}

/** 2. The age of the newest daily backup (desktop app only). */
function backupCheck(asOf: string, opts: HealthOptions['backups']): HealthItem[] {
  if (!opts?.enabled) return [];
  const last = latestBackup(opts.dir);
  if (!last) return [{ id: 'backup', kind: 'backup', status: 'problem', title: 'עוד אין גיבוי של הנתונים', detail: 'האפליקציה מגבה פעם ביום כשהיא פתוחה. אם זה לא קורה, כדאי לבדוק ביומן.', href: '/logs', hrefLabel: 'ליומן' }];
  const age = daysBetween(last, asOf);
  return [age > BACKUP_DAYS
    ? { id: 'backup', kind: 'backup', status: 'problem', title: `הגיבוי האחרון לפני ${age} ימים`, detail: `מ-${dmy(last)}. האפליקציה מגבה פעם ביום כשהיא פתוחה.`, href: '/logs', hrefLabel: 'ליומן' }
    : { id: 'backup', kind: 'backup', status: 'ok', title: age === 0 ? 'יש גיבוי מהיום' : `הגיבוי האחרון מ-${dmy(last)}` }];
}

/** 3. Expenses of the last 90 days without a category (share of the money). */
function uncategorizedCheck(txs: Tx[], asOf: string): HealthItem {
  const since = addDays(asOf, -90);
  const recent = txs.filter(t => t.kind === 'expense' && t.effectiveDate >= since && t.effectiveDate <= asOf);
  const none = recent.filter(t => t.categoryId == null);
  if (!none.length) return { id: 'uncategorized', kind: 'uncategorized', status: 'ok', title: 'לכל ההוצאות של 3 החודשים האחרונים יש קטגוריה' };
  const total = recent.reduce((s, t) => s + Math.abs(t.amount), 0);
  const missing = none.reduce((s, t) => s + Math.abs(t.amount), 0);
  const pct = total > 0 ? Math.round((missing / total) * 100) : 0;
  return {
    id: 'uncategorized', kind: 'uncategorized', status: pct >= UNCATEGORIZED_PROBLEM_PCT ? 'problem' : 'suggestion',
    title: `${none.length} הוצאות בלי קטגוריה ב-3 החודשים האחרונים`,
    detail: `${ils(missing)}, ${pct}% מההוצאות, לא נספרים באף תקציב.`,
    href: '/transactions?review=1', hrefLabel: 'לסווג',
  };
}

/** 4. Possible duplicate charges in the last 45 days. */
function duplicatesCheck(txs: Tx[], asOf: string): HealthItem {
  const pairs = findDuplicateCharges(txs, addDays(asOf, -45));
  if (!pairs.length) return { id: 'duplicates', kind: 'duplicates', status: 'ok', title: 'אין חיובים כפולים אפשריים' };
  return {
    id: 'duplicates', kind: 'duplicates', status: 'problem',
    title: pairs.length === 1 ? 'חיוב כפול אפשרי' : `${pairs.length} חיובים כפולים אפשריים`,
    detail: pairs.slice(0, 3).map(([a, b]) => `${a.description} ${ils(a.amount)} (${dmy(a.date)}, ${dmy(b.date)})`).join(' · '),
    href: `/transactions?search=${encodeURIComponent(pairs[0][0].description)}`, hrefLabel: 'לתנועות',
  };
}

/**
 * 5. Months with no rows in the middle of an account's history (between its first and last month). Only accounts
 * that are normally busy (median ≥ 5 rows a month), so a card used now and then isn't reported.
 */
function gapChecks(db: DB, txs: Tx[]): HealthItem[] {
  const accounts = db.prepare(`SELECT id, COALESCE(display_name, id) AS name FROM accounts WHERE active = 1 AND kind IN ('bank', 'card') AND id != ?`)
    .all(MANUAL_ACCOUNT_ID) as { id: string; name: string }[];
  const items: HealthItem[] = [];
  for (const a of accounts) {
    const counts = new Map<string, number>();
    // installments are dated by their charge, so an old purchase doesn't stretch the history back
    for (const t of txs) if (t.accountId === a.id) {
      const m = (t.txnType === 'installments' ? t.processedDate : t.date).slice(0, 7);
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    const months = [...counts.keys()].sort();
    if (months.length < 3) continue;
    const sorted = [...counts.values()].sort((x, y) => x - y);
    if (sorted[Math.floor(sorted.length / 2)] < 5) continue;
    const missing: string[] = [];
    for (let m = months[0]; m < months.at(-1)!; m = nextMonth(m)) if (!counts.has(m)) missing.push(m);
    if (!missing.length) continue;
    items.push({
      id: `gaps:${a.id}`, kind: 'gaps', status: 'problem',
      title: `ב${a.name} חסרים חודשים באמצע ההיסטוריה`,
      detail: `אין תנועות ב-${missing.slice(0, 6).map(monthLabel).join(', ')}${missing.length > 6 ? ` ועוד ${missing.length - 6}` : ''}. ממוצעים ומגמות יוצאים נמוכים מהאמת. משיכת היסטוריה מלאה (בכפתור העדכון) ממלאת את מה שהבנק עוד שומר.`,
      href: '/', hrefLabel: 'לכפתור העדכון',
    });
  }
  return items;
}

function nextMonth(m: string): string {
  const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7));
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/**
 * 6. A merchant the user categorized by hand at least 3 times, always to the same category, that no rule covers yet:
 * suggest a rule ("create" = POST /rules from one of its rows, applied to the existing rows too).
 */
function ruleSuggestions(db: DB, txs: Tx[]): HealthItem[] {
  const rules = db.prepare(`SELECT match_type, pattern FROM category_rules WHERE set_category_id IS NOT NULL`).all() as { match_type: string; pattern: string }[];
  const covered = (description: string) => {
    const d = description.trim().toLowerCase();
    return rules.some(r => (r.match_type === 'exact' ? d === r.pattern.trim().toLowerCase() : d.includes(r.pattern.trim().toLowerCase())));
  };
  const byMerchant = new Map<string, Tx[]>();
  for (const t of txs) if (t.categorySource === 'manual' && t.categoryId != null && t.merchant) {
    byMerchant.set(t.merchant, [...(byMerchant.get(t.merchant) ?? []), t]);
  }
  const items: HealthItem[] = [];
  for (const [merchant, rows] of byMerchant) {
    const categories = new Set(rows.map(t => t.categoryId));
    if (rows.length < RULE_MIN_MANUAL || categories.size !== 1) continue;
    const sample = rows.at(-1)!;
    if (covered(sample.description)) continue;
    // rows of the same merchant that still have another category (or none) would change when the rule is applied
    const others = txs.filter(t => t.merchant === merchant && t.categoryId !== sample.categoryId && t.categorySource !== 'manual').length;
    items.push({
      id: `rule:${merchant}`, kind: 'rule', status: 'suggestion',
      title: `כלל סיווג: „${sample.description}" ← ${sample.categoryName ?? 'קטגוריה'}`,
      detail: `סיווגתם ידנית ${rows.length} פעמים לאותה קטגוריה. כלל יסווג לבד את הבאות${others ? `, וגם ${others} קיימות שסווגו אחרת` : ''}.`,
      actions: [{ label: 'ליצור כלל', method: 'POST', path: '/rules', body: { fromTransactionId: sample.id, setCategoryId: sample.categoryId } }],
    });
  }
  return items.sort((a, b) => a.title.localeCompare(b.title)).slice(0, 10);
}

/** 7. Payback / refund links waiting for a yes or no (each with confirm / reject), and planned expenses past their date. */
function waitingChecks(db: DB, asOf: string): HealthItem[] {
  const links = db.prepare(`
    SELECT l.id, l.type, l.amount, f.description AS from_desc, f.date AS from_date, t.description AS to_desc, t.date AS to_date, t.charged_amount AS to_amount
    FROM transaction_links l JOIN transactions f ON f.id = l.from_txn_id JOIN transactions t ON t.id = l.to_txn_id
    WHERE l.status = 'suggested' ORDER BY t.date DESC, l.id DESC LIMIT 20
  `).all() as { id: number; type: string; amount: number; from_desc: string; from_date: string; to_desc: string; to_date: string; to_amount: number }[];
  const items: HealthItem[] = links.map(l => ({
    id: `link:${l.id}`, kind: 'links', status: 'suggestion',
    title: `${l.type === 'refund' ? 'זיכוי' : 'החזר'} של ${ils(l.amount)} על ${l.to_desc}?`,
    detail: `„${l.from_desc}" מ-${dmy(localDate(l.from_date))}, על הוצאה של ${ils(l.to_amount)} מ-${dmy(localDate(l.to_date))}. עד שמאשרים, ההוצאה נספרת במלואה.`,
    actions: [
      { label: 'כן, זה החזר', method: 'PATCH', path: `/links/${l.id}`, body: { status: 'confirmed' } },
      { label: 'לא קשור', method: 'PATCH', path: `/links/${l.id}`, body: { status: 'rejected' } },
    ],
  }));
  const planned = db.prepare(`SELECT COUNT(*) AS n, MIN(date) AS first FROM planned_items WHERE status = 'planned' AND date < ?`).get(addDays(asOf, -7)) as { n: number; first: string | null };
  if (planned.n) {
    items.push({
      id: 'planned', kind: 'planned', status: 'suggestion',
      title: `${planned.n} הוצאות מתוכננות שהתאריך שלהן עבר ולא חויבו`,
      detail: `הראשונה מ-${dmy(planned.first!)}. הן עדיין נספרות בתחזית ובתקציב: לבחור את החיוב, לדחות או לבטל.`,
      href: '/fixed#planned', hrefLabel: 'להוצאות הצפויות',
    });
  }
  return items;
}

/** 8. Cards whose paying bank account is neither set nor detected. */
function billingChecks(db: DB, txs: Tx[]): HealthItem[] {
  const cards = db.prepare(`SELECT id, COALESCE(display_name, id) AS name FROM accounts WHERE kind = 'card' AND active = 1`).all() as { id: string; name: string }[];
  if (!cards.length) return [];
  const billing = inferBillingAccounts(db, txs);
  const unknown = cards.filter(c => !billing.get(c.id));
  if (!unknown.length) return [{ id: 'billing', kind: 'billing', status: 'ok', title: 'לכל כרטיס ידוע מאיזה חשבון הוא משולם' }];
  return unknown.map(c => ({
    id: `billing:${c.id}`, kind: 'billing', status: 'problem',
    title: `לא ידוע מאיזה חשבון בנק משולם ${c.name}`,
    detail: 'בלי זה החיוב של הכרטיס לא נכנס לתחזית ול„כמה אפשר להוציא ביום".',
    href: '/settings#accounts', hrefLabel: 'להגדרות',
  }));
}

/** 9. Bank balances not updated for more than 3 days. */
function staleChecks(db: DB, asOf: string): HealthItem[] {
  const stale = bankBalances(db).filter(a => !a.balanceDate || daysBetween(a.balanceDate.slice(0, 10), asOf) > STALE_DAYS);
  if (!stale.length) return [{ id: 'stale', kind: 'stale', status: 'ok', title: 'כל היתרות בבנק עדכניות' }];
  return stale.map(a => ({
    id: `stale:${a.id}`, kind: 'stale', status: 'problem',
    title: `היתרה של ${a.display_name ?? a.id} לא התעדכנה ${a.balanceDate ? `מאז ${dmy(a.balanceDate)}` : 'אף פעם'}`,
    detail: 'התחזית ו„כמה אפשר להוציא ביום" מתחילים מהיתרה הזו. עדכון מהבנק מתקן.',
    href: '/', hrefLabel: 'לכפתור העדכון',
  }));
}

/** What the user chose to ignore: check id → the exact wording ignored. */
export function ignoredWordings(db: DB): Record<string, string> {
  try {
    const v = JSON.parse(getSetting(db, 'health_ignore', '{}'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** All the checks in one list: problems first, then suggestions, then what's fine. */
export function healthReport(db: DB, opts: HealthOptions = {}): HealthReport {
  const asOf = opts.asOf ?? today();
  const txs = loadTransactions(db);
  const items = [
    ...syncChecks(db), ...backupCheck(asOf, opts.backups ?? { enabled: IN_DESKTOP }), ...staleChecks(db, asOf), ...billingChecks(db, txs),
    duplicatesCheck(txs, asOf), uncategorizedCheck(txs, asOf), ...gapChecks(db, txs), ...waitingChecks(db, asOf), ...ruleSuggestions(db, txs),
  ];
  const ignored = ignoredWordings(db);
  for (const i of items) if (i.status !== 'ok' && ignored[i.id] === wordingOf(i)) i.ignored = true;
  const rank = (i: HealthItem) => (i.ignored ? 3 : i.status === 'problem' ? 0 : i.status === 'suggestion' ? 1 : 2);
  items.sort((a, b) => rank(a) - rank(b));
  return {
    items,
    problems: items.filter(i => i.status === 'problem' && !i.ignored).length,
    suggestions: items.filter(i => i.status === 'suggestion' && !i.ignored).length,
  };
}

/** Ignore one row as it reads now (it returns when its wording changes), or stop ignoring it. */
export function setIgnored(db: DB, id: string, ignore: boolean, opts: HealthOptions = {}): boolean {
  const current = ignoredWordings(db);
  const { items } = healthReport(db, opts);
  if (ignore) {
    const item = items.find(i => i.id === id);
    if (!item || item.status === 'ok') return false;
    current[id] = wordingOf(item);
  } else delete current[id];
  // forget ignores of rows that no longer exist, so the setting doesn't grow forever
  const live = new Set(items.map(i => i.id));
  for (const k of Object.keys(current)) if (!live.has(k) && k !== id) delete current[k];
  db.prepare(`INSERT INTO settings (key, value) VALUES ('health_ignore', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(current));
  return true;
}

