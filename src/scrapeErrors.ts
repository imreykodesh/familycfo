/**
 * A failed scrape in words: what probably happened and what to do, from the scraper's error type and message
 * (and, when kept, the text that was on the bank's page when it closed). Pure — used by the API and the tests.
 */

export interface ScrapeErrorExplanation {
  /** short Hebrew title */
  title: string;
  /** what to do about it, in Hebrew */
  hint: string;
  /** login = the credentials / the account; site = the bank's site or the network; setup = this computer; unknown */
  kind: 'login' | 'site' | 'setup' | 'otp' | 'unknown';
  /** worth retrying as is */
  retry: boolean;
}

interface Rule { test: (type: string, text: string) => boolean; explain: ScrapeErrorExplanation }

const has = (re: RegExp) => (_: string, text: string) => re.test(text);

// the scraper's own login verdicts first; then message patterns, which explain a GENERIC / EXCEPTION better than its type
const RULES: Rule[] = [
  {
    test: type => type === 'INVALID_PASSWORD',
    explain: { kind: 'login', retry: false, title: 'שם משתמש או סיסמה שגויים',
      hint: 'בדקו את פרטי ההתחברות בקובץ accounts.json מול האתר של הבנק. אחרי כמה ניסיונות שגויים הבנק עלול לחסום את המשתמש.' },
  },
  {
    test: type => type === 'CHANGE_PASSWORD',
    explain: { kind: 'login', retry: false, title: 'הבנק מבקש להחליף סיסמה',
      hint: 'היכנסו לאתר הבנק בדפדפן, החליפו סיסמה, ועדכנו את הסיסמה החדשה ב-accounts.json.' },
  },
  {
    test: type => type === 'ACCOUNT_BLOCKED',
    explain: { kind: 'login', retry: false, title: 'המשתמש חסום באתר הבנק',
      hint: 'פנו לבנק או לחברת האשראי כדי לשחרר את החסימה, ורק אחר כך נסו שוב (ניסיונות נוספים עלולים להאריך אותה).' },
  },
  {
    test: has(/could not find (chrome|chromium|expected browser)|executablePath|browser was not found|failed to launch the browser/i),
    explain: { kind: 'setup', retry: false, title: 'לא נמצא דפדפן Chrome במחשב',
      hint: 'הסריקה פותחת Chrome כדי להתחבר לבנק. התקינו Google Chrome, או הריצו npx puppeteer browsers install chrome.' },
  },
  {
    test: has(/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_NETWORK_CHANGED|ECONNRESET|ERR_CONNECTION/i),
    explain: { kind: 'site', retry: true, title: 'בעיית חיבור לאינטרנט',
      hint: 'המחשב לא הצליח להגיע לאתר הבנק. בדקו את החיבור לאינטרנט (או VPN שחוסם), ונסו שוב.' },
  },
  {
    test: has(/\b429\b|too many requests|rate.?limit/i),
    explain: { kind: 'site', retry: true, title: 'האתר חסם זמנית בגלל ריבוי בקשות',
      hint: 'חברת האשראי מגבילה כמה פעמים אפשר להתחבר. חכו כשעה לפני שמנסים שוב, ואל תריצו כמה עדכונים ברצף.' },
  },
  {
    test: has(/captcha|bot detect|access denied|blocked by|forbidden|\b403\b/i),
    explain: { kind: 'site', retry: true, title: 'האתר זיהה גלישה אוטומטית',
      hint: 'נסו שוב עם חלון דפדפן גלוי (SHOW_BROWSER לא מוגדר ל-0), והתחברו פעם אחת ידנית באתר מאותו מחשב.' },
  },
  {
    test: (type, text) => type === 'TWO_FACTOR_RETRIEVER_MISSING' || /otp|sms|קוד אימות|one.?time/i.test(text),
    explain: { kind: 'otp', retry: true, title: 'נדרש קוד אימות (SMS) ולא הוזן',
      hint: 'הבנק שלח קוד אימות. בעדכון הבא הזינו את הקוד בחלון שנפתח ליד כפתור ״עדכון נתונים״ תוך 2 דקות.' },
  },
  {
    test: (type, text) => type === 'TIMEOUT' || /timeout|timed out|navigation.*exceeded/i.test(text),
    explain: { kind: 'site', retry: true, title: 'האתר לא הגיב בזמן',
      hint: 'אתר הבנק איטי או לא זמין כרגע (לפעמים בזמן תחזוקה, בלילה או בסופ״ש). נסו שוב מאוחר יותר.' },
  },
  {
    test: has(/accounts\.json|credentials|no such file|configuration/i),
    explain: { kind: 'setup', retry: false, title: 'בעיה בהגדרות ההתחברות',
      hint: 'בדקו שהקובץ accounts.json קיים ותקין (ראו accounts.example.json), ושה-companyId נכון.' },
  },
  {
    test: has(/selector|waiting for|element|cannot read propert|undefined|null/i),
    explain: { kind: 'site', retry: true, title: 'האתר של הבנק השתנה או נטען באופן חלקי',
      hint: 'אם זה חוזר כמה ימים ברצף, סביר שהבנק שינה את האתר וצריך לעדכן את israeli-bank-scrapers (npm update israeli-bank-scrapers).' },
  },
];

const UNKNOWN: ScrapeErrorExplanation = {
  kind: 'unknown', retry: true, title: 'העדכון נכשל משגיאה לא מזוהה',
  hint: 'נסו שוב. אם זה חוזר, פתחו את ״יומן ותקלות״ ובדקו את השורות האדומות סביב הזמן הזה, או בקשו מהעוזר להסביר.',
};

export function explainScrapeError(errorType: string | null | undefined, errorMessage?: string | null, pageState?: string | null): ScrapeErrorExplanation {
  const type = (errorType ?? '').toUpperCase();
  const text = `${errorMessage ?? ''}\n${pageState ?? ''}`;
  // the bank's own page text is the best clue for a wrong password reported as a generic error
  if (/סיסמה שגויה|פרטים שגויים|פרטי ההזדהות שגויים|שם משתמש או סיסמה|invalid (user|password)/i.test(pageState ?? '')) {
    return RULES.find(r => r.explain.title === 'שם משתמש או סיסמה שגויים')!.explain;
  }
  return RULES.find(r => r.test(type, text))?.explain ?? UNKNOWN;
}
