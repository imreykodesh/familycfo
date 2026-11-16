import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import { getDb, type DB } from './db/connection.js';
import { saveScrapedAccount, recordScrapeRun } from './db/ingestRepo.js';
import * as readline from 'readline';
import type { Page } from 'puppeteer';
import { findBrowser, NO_BROWSER } from './browser.js';

interface AccountConfig {
  companyId: keyof typeof CompanyTypes;
  credentials: Record<string, string>;
  /** the desktop app's login id and label (two logins of one company) */
  id?: string;
  label?: string;
}

export interface Config {
  accounts: AccountConfig[];
  /** optional external categorizer: POST {description} → {category} */
  categoryApiUrl?: string;
}

/** Lets a caller (the API's scrape job) run the scrape: answer the OTP and follow progress. */
export interface ScrapeHooks {
  /** asked when the bank shows its OTP screen; defaults to the terminal. '' gives up */
  requestOtp?: (company: string) => Promise<string>;
  onProgress?: (event: ScrapeProgress) => void;
  /** show the browser window (false = headless); defaults to SHOW_BROWSER, which is on unless '0' */
  showBrowser?: boolean;
}
export type ScrapeProgress =
  | { type: 'start'; company: string }
  | { type: 'done'; company: string; success: boolean; newTransactions: number; errorType?: string; errorMessage?: string };

async function promptOtp(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('\n🔐 Enter OTP code (5 digits): ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function startOtpWatcher(page: Page, requestOtp: () => Promise<string>): Promise<void> {
  const maxWait = 90000;
  const interval = 1000;
  let waited = 0;
  let otpHandled = false;

  while (waited < maxWait && !otpHandled) {
    try {
      // Check if OTP modal is visible
      const otpModal = await page.$('poalim-separated-characters-input');
      if (otpModal) {
        console.log('\n📱 OTP popup detected!');
        const otp = await requestOtp();
        if (!otp) return;

        // Fill each digit into separate inputs
        const inputs = await page.$$('poalim-separated-characters-input input');
        for (let i = 0; i < Math.min(otp.length, inputs.length); i++) {
          await inputs[i].type(otp[i], { delay: 50 });
        }

        // Click submit button
        const submitBtn = await page.$('button.btn-red_1');
        if (submitBtn) {
          await submitBtn.click();
          console.log('✅ OTP submitted');
        }
        
        otpHandled = true;
        return;
      }

      // Check if we've moved past login (success)
      const url = page.url();
      if (!url.includes('login') && !url.includes('auth')) {
        return; // Login completed without OTP
      }
    } catch {
      // Frame detached or other error - page might have navigated, just continue
    }

    await new Promise(r => setTimeout(r, interval));
    waited += interval;
  }
}

// Describe where the browser ended up, for diagnosing failed logins. Uses visible
// text only (innerText never includes typed input values), so credentials are not logged.
async function describePage(page: Page): Promise<string> {
  const lines = [`  URL: ${page.url()}`];
  for (const frame of page.frames()) {
    try {
      const text = await frame.evaluate(() => document.body?.innerText ?? '');
      const compact = text.replace(/\s+/g, ' ').trim().slice(0, 800);
      if (compact) lines.push(`  Visible text [${frame.url().slice(0, 80)}]: ${compact}`);
    } catch {
      // frame detached mid-navigation; skip it
    }
  }
  return lines.join('\n');
}

export interface ScrapeSummary {
  company: string;
  success: boolean;
  newTransactionIds: number[];
  errorType?: string;
}

export const DEFAULT_MONTHS_BACK = 3;
export const MAX_MONTHS_BACK = 24;
/**
 * How far back `from = 'max'` asks for. Each company's scraper clamps the start to what its site gives
 * (israeli-bank-scrapers 6.x: Max 4 years, Leumi 3, Cal 18 months, Hapoalim / Discount / Mizrahi /
 * Isracard / Amex about a year), so asking for more is safe — every company returns as much as it can.
 */
export const MAX_HISTORY_YEARS = 5;

/** Months of history a scrape fetches: SCRAPE_MONTHS env, else the `scrape_months_back` setting, else 3 (1–24). */
export function scrapeMonthsBack(db: DB): number {
  const raw = process.env.SCRAPE_MONTHS
    ?? (db.prepare(`SELECT value FROM settings WHERE key = 'scrape_months_back'`).pluck().get() as string | undefined);
  const n = Math.round(Number(raw));
  return raw != null && Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_MONTHS_BACK) : DEFAULT_MONTHS_BACK;
}

/**
 * The scrape's start date: `from` (YYYY-MM-DD, or 'max' = as far back as each company allows), else the
 * SCRAPE_FROM env (same values), else `scrapeMonthsBack` months back.
 */
export function scrapeStartDate(db: DB, from = process.env.SCRAPE_FROM, now = new Date()): Date {
  const start = new Date(now);
  if (from === 'max') {
    start.setFullYear(start.getFullYear() - MAX_HISTORY_YEARS);
    return start;
  }
  if (from) {
    const date = new Date(`${from}T00:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(date.getTime())) throw new Error(`SCRAPE_FROM is not a date (YYYY-MM-DD or max): ${from}`);
    return date;
  }
  start.setMonth(start.getMonth() - scrapeMonthsBack(db));
  return start;
}

export interface ScrapeOptions {
  /** only log in and read a few days, to check the login: nothing is saved */
  checkOnly?: boolean;
  /** 'max' (as far back as each company allows) or YYYY-MM-DD; default SCRAPE_FROM, else the months-back setting */
  from?: string;
}

export async function scrapeAll(config: Config, db: DB = getDb(), hooks: ScrapeHooks = {}, opts: ScrapeOptions = {}): Promise<ScrapeSummary[]> {
  // a login check reads only the last 7 days
  const startDate = opts.checkOnly ? new Date(Date.now() - 7 * 86_400_000) : scrapeStartDate(db, opts.from ?? process.env.SCRAPE_FROM);
  const startDay = startDate.toISOString().slice(0, 10);
  console.log(`Scraping from ${startDay}`);

  // SCRAPE_ONLY=visaCal,leumi limits the run to those companies
  const only = process.env.SCRAPE_ONLY?.split(',').map(s => s.trim()).filter(Boolean);
  const summaries: ScrapeSummary[] = [];
  const browser = await findBrowser();
  if (!browser) throw new Error(NO_BROWSER);

  for (const account of config.accounts) {
    if (only && !only.includes(account.companyId)) continue;
    console.log(`Scraping ${account.companyId}...`);
    hooks.onProgress?.({ type: 'start', company: account.companyId });
    const startedAt = new Date().toISOString();
    let pageStateAtClose: string | undefined;

    try {
      const scraper = createScraper({
        companyId: CompanyTypes[account.companyId],
        startDate,
        futureMonthsToScrape: opts.checkOnly ? 0 : 2, // upcoming card charges and future installments
        // per-transaction detail requests (e.g. Isracard PirteyIska_204) get rate-limited (HTTP 429) as automation
        additionalTransactionInformation: false,
        includeRawTransaction: true,
        verbose: true,
        combineInstallments: false,
        showBrowser: hooks.showBrowser ?? process.env.SHOW_BROWSER !== '0',
        timeout: 120000, // 2 minutes for OTP
        defaultTimeout: 120000, // 2 minutes for navigation
        navigationRetryCount: 1,
        executablePath: browser.path,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-infobars',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-sync',
          '--disable-translate',
          '--hide-scrollbars',
          '--metrics-recording-only',
          '--mute-audio',
          '--safebrowsing-disable-auto-update',
          '--window-size=1920,1080',
        ],
        preparePage: async (page: Page) => {
          // The library closes the page before returning a failed result, so snapshot it on close
          const closePage = page.close.bind(page);
          page.close = async (...args: Parameters<Page['close']>) => {
            pageStateAtClose = await describePage(page);
            return closePage(...args);
          };

          // Use the real browser's user agent (minus "Headless") so it matches the
          // sec-ch-ua client hints; a hardcoded version mismatch trips bot detection
          const realUserAgent = await page.browser().userAgent();
          await page.setUserAgent(realUserAgent.replace('HeadlessChrome', 'Chrome'));

          // Remove webdriver property and other automation flags
          await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

            // Override plugins
            Object.defineProperty(navigator, 'plugins', {
              get: () => [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                { name: 'Native Client', filename: 'internal-nacl-plugin' },
              ],
            });

            // Override languages
            Object.defineProperty(navigator, 'languages', {
              get: () => ['he-IL', 'he', 'en-US', 'en'],
            });

            // Override permissions
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters: PermissionDescriptor) =>
              parameters.name === 'notifications'
                ? Promise.resolve({ state: 'denied' } as PermissionStatus)
                : originalQuery(parameters);
          });

          // Set extra HTTP headers
          await page.setExtraHTTPHeaders({
            'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
          });

          // Start OTP watcher in background for Hapoalim
          if (account.companyId === 'hapoalim') {
            const ask = hooks.requestOtp ? () => hooks.requestOtp!(account.companyId) : promptOtp;
            startOtpWatcher(page, ask).catch(() => {}); // Fire and forget
          }
        },
      });

      const result = await scraper.scrape(account.credentials as never);

      if (!result.success) {
        console.error(`Failed to scrape ${account.companyId}:`, result.errorType, result.errorMessage);
        if (pageStateAtClose) console.error(pageStateAtClose);
        if (!opts.checkOnly) recordScrapeRun(db, { company: account.companyId, startedAt, success: false, startDate: startDay,
          errorType: result.errorType, errorMessage: result.errorMessage, pageState: pageStateAtClose });
        summaries.push({ company: account.companyId, success: false, newTransactionIds: [], errorType: result.errorType });
        hooks.onProgress?.({ type: 'done', company: account.companyId, success: false, newTransactions: 0,
          errorType: result.errorType, errorMessage: result.errorMessage });
        continue;
      }

      const newIds: number[] = [];
      if (opts.checkOnly) {
        console.log(`  ${account.companyId}: login OK`);
        summaries.push({ company: account.companyId, success: true, newTransactionIds: [] });
        hooks.onProgress?.({ type: 'done', company: account.companyId, success: true, newTransactions: 0 });
        continue;
      }
      for (const acc of result.accounts ?? []) {
        const saved = saveScrapedAccount(db, account.companyId, acc);
        newIds.push(...saved.insertedIds);
        const label = acc.savingsAccount ? ' (savings deposit)' : '';
        console.log(`  ${saved.accountId}${label}: balance ${acc.balance ?? '-'} ${acc.currency ?? 'ILS'}, ${saved.insertedIds.length} new, ${saved.updated} updated`);
      }
      recordScrapeRun(db, { company: account.companyId, startedAt, success: true, newTransactions: newIds.length, startDate: startDay });
      summaries.push({ company: account.companyId, success: true, newTransactionIds: newIds });
      hooks.onProgress?.({ type: 'done', company: account.companyId, success: true, newTransactions: newIds.length });
    } catch (err) {
      console.error(`Error scraping ${account.companyId}:`, err);
      if (!opts.checkOnly) recordScrapeRun(db, { company: account.companyId, startedAt, success: false, startDate: startDay,
        errorType: 'EXCEPTION', errorMessage: err instanceof Error && err.stack ? err.stack.slice(0, 2000) : String(err), pageState: pageStateAtClose });
      summaries.push({ company: account.companyId, success: false, newTransactionIds: [], errorType: 'EXCEPTION' });
      hooks.onProgress?.({ type: 'done', company: account.companyId, success: false, newTransactions: 0,
        errorType: 'EXCEPTION', errorMessage: err instanceof Error ? err.message : String(err) });
    }
  }
  return summaries;
}
