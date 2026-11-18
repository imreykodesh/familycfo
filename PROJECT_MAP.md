# PROJECT_MAP.md

מפת הקוד של FamilyCFO: איפה כל דבר נמצא, אילו נתיבי API, טבלאות, מפתחות הגדרה ומפתחות אחסון קיימים, ומה התלויות.
**קוראים את הקובץ הזה לפני כל משימה, ומעדכנים אותו באותה משימה** (הכללים ב-`.kiro/steering/project-map.md`).
כללי החשבונאות (מה נחשב הוצאה, חיובי כרטיס, העברות, תשלומים, עריכה ידנית) נמצאים ב-[CLAUDE.md](CLAUDE.md) — לא לשבור אותם.

---

## סקירה כללית

**שם:** FamilyCFO ("הכספים של הבית") · package: `familycfo` · גרסה ב-`package.json` (`version`, גרסת אפליקציית הדסקטופ).
**מטרה:** ניהול כספי משפחתי מקומי בעברית: משיכת תנועות מהבנקים ומחברות האשראי, תזרים, תקציב, תחזית, שווי נקי,
ביטוחים, פנסיה, תיק השקעות, וצ'אט AI שקורא ומעדכן את הנתונים.
**איך זה רץ:**
- **אפליקציית דסקטופ** (Electron, `desktop/`): מתקינים מ-`release\FamilyCFO-<גרסה>-x64.exe` (נבנה ב-`build-windows.cmd`).
  השרת רץ כתהליך בן על `127.0.0.1:4330` ומגיש גם את הממשק הבנוי.
- **מהקוד** (`npm run dev`): API על `127.0.0.1:4310` + Vite על `http://127.0.0.1:5180`.
**טכנולוגיות:** TypeScript, Node ≥ 20, Fastify 5, SQLite (better-sqlite3), israeli-bank-scrapers + Puppeteer,
React 19 + Vite + Tailwind 4 + TanStack Query + react-router 7, Electron + electron-builder, Vitest.
**פרטיות:** הכל מקומי. ה-API מאזין רק ל-127.0.0.1, בלי התחברות, ודוחה `Host` / `Origin` שאינם מקומיים (`src/server/web.ts`).

---

## סקריפטים

| מה | איך | הערות |
|---|---|---|
| בדיקה לפני commit | `npm run check` (`scripts/check.mjs`) | התקנה אם חסר → typecheck (API + דסקטופ) → typecheck (web) → בדיקות. בלי בנייה. `-- --clean`, `-- --skip-tests` |
| קובץ התקנה לווינדוס | לחיצה כפולה על `build-windows.cmd` | התקנה (`npm ci`) אם `node_modules` חסר או ישן מ-`package-lock.json` → typecheck → בניית הממשק → bundle לדסקטופ → electron-builder → `release\`. רק על ווינדוס |
| סנכרון גיט | לחיצה כפולה על `git-sync.cmd` (`git-sync.ps1`) | משיכה ודחיפה של הענף הנוכחי. של המשתמש — לא לשנות בלי בקשה מפורשת |
| פיתוח | `npm run dev` / `npm run dev:demo` | |
| דסקטופ מהקוד | `npm run desktop:dev` · `desktop:pack` · `desktop:dist` | |
| משיכה מהבנקים | `npm run scrape` | `SCRAPE_FROM=max` / תאריך, `SCRAPE_MONTHS`, `SCRAPE_ONLY`, `SHOW_BROWSER=0`, `SCHEDULE` |
| עיבוד מחדש | `npm run pipeline` | |
| מיגרציות | `npm run migrate` (רץ גם בכל פתיחה) | |
| ייבוא דוחות | `npm run import:pension -- <json>` · `npm run import:insurance -- <json>` | `docs/importing.md`. למשתמש: כפתור „ייבוא דוח" בפנסיה, ביטוחים, הלוואות |
| נתוני דמו | `npm run demo` → `demo.db` | |
| שחרור גרסה | `version` ב-`package.json` → תגית `vX.Y.Z` → `.github/workflows/desktop.yml` | Actions רץ רק על תגית או ידנית |

---

## ארכיטקטורת הקבצים והתיקיות

### שורש
| קובץ | תפקיד |
|---|---|
| `PROJECT_MAP.md` | המפה הזו |
| `CLAUDE.md` / `AGENTS.md` | ארכיטקטורה וכללי חשבונאות לסוכני קוד (אותו תוכן; לעדכן את שניהם) |
| `README.md` | למשתמש: התקנה, פרטיות, הגדרות |
| `CONTRIBUTING.md`, `SECURITY.md` | כללי תרומה ואבטחה |
| `build-windows.cmd` | בניית קובץ ההתקנה לווינדוס |
| `git-sync.cmd`, `git-sync.ps1` | סנכרון גיט דו-כיווני (של המשתמש) |
| `electron-builder.yml` | הגדרות האריזה (מקור: `build/desktop/**`, יעד: `release/`) |
| `.gitattributes` | `*.cmd` נשמרים עם CRLF |
| `accounts.example.json` | דוגמה ל-`accounts.json` (פרטי כניסה לבנקים, מחוץ לגיט) |
| `.kiro/steering/`, `.cursor/rules` | כללי עבודה לסוכני AI |
| `docs/plans/` | מסמכי תכנון (`budget-helpers.md`: כלי ניהול ועזרה פיננסית — שלבים, חישובים, API) |

### `src/` — שרת, משיכה, ניתוח
| קובץ | תפקיד |
|---|---|
| `index.ts` | `npm run scrape`: משיכה פעם אחת או לפי `SCHEDULE` |
| `scraper.ts` | הרצת israeli-bank-scrapers: `scrapeAll`, `scrapeStartDate` (`from`: `max` = 5 שנים / תאריך / הגדרת חודשים), OTP של הפועלים |
| `browser.ts` | איתור Chrome/Edge מותקן או הורדת Chrome for Testing (`findBrowser`, `startBrowserDownload`) |
| `config.ts` | פרטי הכניסה: `accounts.json` או ספק מהדסקטופ (`setConfigProvider`, `loadConfig`) |
| `paths.ts` | `DATA_DIR` (`HOUSEHOLD_HOME`), `APP_DIR` (`HOUSEHOLD_APP_DIR`), `IN_DESKTOP` |
| `pipeline.ts` | אחרי כל משיכה: שערים → סיווג → סוגים → חיובי כרטיס → העברות → קבועות → אימות מעבר כרטיס / ביטולים → הצעות → החזרים → התראות |
| `categorizer.ts` | סיווג חיצוני אופציונלי (`category_api_url`) |
| `log.ts` | קבצי יומן `data/logs` (14 יום): `installFileLog`, `readLogs` |
| `scrapeErrors.ts` | הסבר בעברית לכשל משיכה (`explainScrapeError`) |
| `demo.ts` | בניית `demo.db` |
| `db/connection.ts` | `openDb`, `getDb` (פותח ומריץ מיגרציות) |
| `db/migrations.ts` | מיגרציות ממוספרות (אחרונה: 23). לא לערוך מיגרציה ששוחררה — רק להוסיף בסוף |
| `db/migrate.ts` | `runMigrations` |
| `db/ingestRepo.ts` | שמירת חשבונות ותנועות שנמשכו (`saveScrapedAccount`, `recordScrapeRun`); לא דורס שדות שנערכו ידנית; תנועה ממתינה מתחלפת בתנועה שנקלטה מאותו יום בישראל, וממתינה שחברת האשראי כבר לא מחזירה נמחקת |
| `db/backup.ts` | גיבוי יומי של המסד (`dailyBackup`), תאריך הגיבוי האחרון (`latestBackup`) |
| `db/importData.ts` | ייבוא משק בית קיים לדסקטופ (`importHousehold`) |
| `ingest/normalize.ts` | זהות תנועה ומניעת כפילויות, `localDate`; לתנועה ממתינה בלי סכום חיוב (מקס) נותנים את סכום הקנייה, רק בשקלים |
| `ingest/classify.ts` | כללים → מטמון → קטגוריית חברת האשראי (`scraperCategory`: שם קיים / כינוי → המיפוי לקטגוריה קיימת; אף פעם לא יוצר קטגוריה) → API; `deriveKinds` |
| `ingest/scraperCategories.ts` | `SCRAPER_CATEGORY_MAP`: שמות הקטגוריות של מקס / ישראכרט / כאל → קטגוריות ברירת המחדל |
| `ingest/transfers.ts` | התאמת חיובי כרטיס והעברות בין חשבונות |
| `import/pensionReport.ts`, `import/insurancePolicies.ts` | ייבוא דוחות JSON (`importPensionReport`, `importInsurance`) — משורת הפקודה או מה-API |
| `agent/mcp.ts` | שרת ה-MCP של הצ'אט: `api` (GET מרשימה), `sql` (קריאה בלבד), `change` (שינוי דרך ה-API, מרשימה), `read_document` (ל-Gemini / Kiro: מסמכים מ-`data/policies` ו-`data/reports` בלבד) |
| `agent/guard-read.mjs` | מגביל את `Read` של Claude לעותק `docs/` |

### `src/analytics/` — פונקציות טהורות
| קובץ | פונקציות מרכזיות |
|---|---|
| `common.ts` | `loadTransactions`, `filterTx`, `spendOf` / `incomeOf` / `refundOf`, מחזורים: `cycleFor`, `cycleByKey`, `recentCycles`, `getSetting`, `cycleStartDay`, `merchantKey` |
| `cashflow.ts` | `cashflowHistory`, `cycleSummary`, `summarizeCycle`, `monthIncome`, `expectedIncome`, `spendBaseline`, `historyRange` (טווח ההיסטוריה לפי חברה), `cyclesSince` |
| `balances.ts` | `balanceHistory` (יתרה יומית/חודשית לאחור), `dataCoverage` (טווח תאריכים לכל חשבון) |
| `budgets.ts` | `budgetStatus` |
| `forecast.ts` | `buildForecast`, `bankBalances`, `planningPeriod` |
| `cards.ts` | `upcomingCardCharges`, `installmentPlans`, `cardCommitments` |
| `commitments.ts` | `monthPlan` |
| `planned.ts` | הוצאות מתוכננות: `listPlanned`, `matchPlanned`, `plannedSpend` |
| `planning.ts` | `savingsCapacity` (בלי הקופה לאירועים), `tightMonthPlan` |
| `allowance.ts` | כמה אפשר להוציא ביום: `computeAllowance` (טהורה), `buildAllowance`, `committedCardAmount` |
| `hebcal.ts` | לוח עברי בלי ספרייה (Intl): `hebrewParts`, `occurrences`, `nextOccurrence`, `lastOccurrence`, `HEBREW_MONTHS` |
| `monthClose.ts` | סגירת חודש ודוח: `monthChecks`, `monthCloseState`, `answerCheck` ("הסתיים" מסיים את הפריט הקבוע), `closeMonth` / `reopenMonth`, `monthSignature`, `closeHistory`, `monthReport` |
| `insurance.ts` | ביטוחים: `insuranceCharges`, `policyMatches`, `monthlyPremium` (משותפים למסך הביטוחים), `insuranceInsights` (תובנות לפי כללים, נכנסות להמלצות) |
| `reminders.ts` | תזכורות: `listReminders`, `autoReminders` (ביטוח / הלוואה / קרן השתלמות / הוצאה מתוכננת), `fireDueReminders` (כל דקה בשרת וב-pipeline → התראות עם `href`), `occurrence`, `occurrencesAround`, `nowLocal` |
| `iou.ts` | הלוואות בין אנשים: `listIous` (עם הצעות להחזר ולתנועת ההלוואה), `iouCandidates` (טהורה), `createIou`, `addIouPayment` / `removeIouPayment`, `setSource`, `rejectIouCandidate`, `deleteIou` |
| `maaser.ts` | מעשרות: `maaserReport` (חודש אחרי חודש: הכנסה, נדרש, ניתן, יתרה מצטברת), `maaserMonth` (טהורה), `maaserConfig` / `parseMaaserConfig` / `saveMaaserConfig`, `donationCategories` |
| `chargeMoves.ts` | מעבר כרטיס וביטול חיובים: `moveCandidates`, `addChargeMoves`, `markChargeMove`, `listChargeMoves`, `verifyChargeMoves` (ב-pipeline אחרי הקבועות), `sameMerchant` |
| `health.ts` | בדיקת תקינות: `healthReport` (משיכות, גיבוי, יתרות ישנות, כרטיס בלי חשבון חיוב, כפילויות, בלי קטגוריה, חודשים חסרים, קישורי החזר והוצאות מתוכננות שממתינים, הצעות לכללי סיווג), `setIgnored`, `wordingOf` |
| `simulator.ts` | סימולטור, טהור ובלי imports (רץ גם בדפדפן): `debtPlan` (בסיס / כדור שלג / מפולת, חודש אחרי חודש), `compareDebtPlans`, `debtQueue`, `cutImpact` |
| `simulatorBase.ts` | הקלט של הסימולטור: `simulatorBase` (ממוצע לכל קטגוריה בחודשים המלאים, יעדי חיסכון, הלוואות עם יתרה, ריבית והחזר; מה חסר ולמה) |
| `seasonal.ts` | קופה לאירועים צפויים: `seasonalPlan`, `monthlySetAside`, `suggestFromHistory`, `ensureSeasonalPot`, `settleSeasonalEvent`, `COMMON_EVENTS` |
| `recurring.ts`, `scheduled.ts` | זיהוי קבועות, הצעות לפריטים קבועים |
| `paybacks.ts` | הצעות להחזרים (`suggestPaybacks`, `samePerson`): ביט / פייבוקס = אותו סכום או חלק ממנו; העברה בנקאית = אותו סכום בדיוק עד 14 יום; כסף שנשלח לאדם = רק כשאותו אדם מחזיר. לא קבועות, לא מזומן, לא הכנסה קבועה, לא זיכויי כרטיס. הצעות שכבר לא מתאימות נמחקות בכל חישוב |
| `alerts.ts`, `recommendations.ts` | התראות (`refreshAlerts`, `takeAlertsToNotify`) והמלצות |
| `networth.ts`, `investments.ts`, `quotes.ts`, `fx.ts` | שווי נקי, תיק השקעות, מחירים מ-Yahoo, שערי בנק ישראל |

### `src/server/` — API
| קובץ | תפקיד |
|---|---|
| `app.ts` | `buildApp` (כל הנתיבים) ו-`startServer({ port, webDist })` |
| `index.ts` | `npm run server`: ה-API בלבד (+ בדיקת תזכורות כל דקה) |
| `desktop.ts` | השרת בתוך אפליקציית הדסקטופ: API + ממשק בנוי, תזמון, גיבוי, התראות, תזכורות (כל דקה, בהתעוררות ובפתיחה); מדבר עם Electron ב-IPC |
| `desktopProtocol.ts` | סוגי ההודעות בין השרת ל-Electron |
| `web.ts` | `localOnly` (חסימת Host/Origin זרים), `serveWeb` (הגשת `web/dist` עם CSP) |
| `crud.ts` | `registerCrud`, `toApi`, `pickColumns` |
| `csv.ts` | `sendCsv` |
| `agent.ts` | הצ'אט: Claude / Gemini / Kiro, ההנחיות, הכלים, SSE |
| `agentSetup.ts` | התקנה וחיבור של Kiro / Gemini, רשימת מודלים |
| `scrapeJob.ts` | משיכה מהממשק: `startScrape({ from, showBrowser, checkOnly, loginIds })`, `submitOtp` |
| `scheduler.ts` | משיכה יומית בשעה קבועה (`scrape_time`) |
| `appEvents.ts` | אירועים לאפליקציית הדסקטופ (`emitAppEvent`) |
| `routes/*.ts` | transactions, analytics, categories, events, insurance, pension, investments, reports (העלאת דוח וייבוא JSON), seasonal (קופה לאירועים + `allowance`), monthClose (סגירת חודש ודוח), simulator (קלט לסימולטור והשוואת החזר חובות), health (בדיקת תקינות), chargeMoves (מעבר כרטיס וביטולים), maaser (מעשרות), iou (הלוואות בין אנשים), reminders (תזכורות) |

### `desktop/` — Electron
| קובץ | תפקיד |
|---|---|
| `main.ts` | חלון, מגש, התראות, עדכונים, הפעלת השרת, ערוצי IPC |
| `preload.ts` | הגשר היחיד לממשק: `window.familycfo` |
| `credentials.ts` | פרטי כניסה לבנקים מוצפנים (safeStorage או סיסמת-על) |
| `vault.ts` | scrypt + AES-GCM לסיסמת-העל |
| `shellEnv.ts` | PATH של מעטפת ההתחברות (כדי למצוא claude / gemini / kiro-cli) |
| `build.mjs` | bundle עם esbuild ל-`build/desktop/` |
| `tsconfig.json` | לבדיקת טיפוסים בלבד (`npm run typecheck`) |

### `web/src/` — ממשק (עברית, RTL)
| קובץ | תפקיד |
|---|---|
| `App.tsx` | ניווט ונתיבים. במצב פשוט: תפריט קצר (`MAIN_SCREENS` + מסכים מוצמדים) והשאר תחת "עוד כלים" עם כפתור הצמדה |
| `api.ts` | `api.get/post/put/patch/delete`, `qs`, כל הטיפוסים |
| `state.tsx` | מסנן גלובלי (בן בית / עסק / תגיות): `useFilters`, `useMeta`, `useLookups`; `useUiMode` (מצב פשוט / מלא, `MAIN_SCREENS`, הצמדה לתפריט) |
| `desktop.ts` | גישה ל-`window.familycfo`, `useDesktopNavigation` |
| `format.ts` | `money`, `day`, `monthName`, `KIND_LABELS`, `todayIso`, `currentCycleKey` (החודש של היום לפי יום תחילת החודש) |
| `components/ui.tsx` | רכיבים משותפים: `Money`, `Stat`, `Modal`, `Picker`, `Segmented`, `PageHeader`, בוררים |
| `components/charts.tsx` | גרפים |
| `components/AgentChat.tsx` | חלון הצ'אט: קישורים `/…`, תשובות מהירות `ask:…`, תגיות שינוי, רענון אחרי שינוי, `askAgent()` |
| `components/AgentSetup.tsx` | בחירת מודל, חיבור Kiro / Gemini |
| `components/BankLogins.tsx`, `MasterPassword.tsx` | פרטי כניסה לבנקים בדסקטופ |
| `components/ImportDocuments.tsx` | כפתור „ייבוא דוח" (`ImportDocumentsButton`): PDF / תמונה → `data/reports` ← הצ'אט מייבא (skill `import-document`); JSON → ייבוא ישיר |
| `components/ScrapeButton.tsx` | כפתור העדכון, OTP, "משיכת היסטוריה מלאה" |
| `components/ManualEntry.tsx`, `ScheduledManager.tsx`, `CategoryReport.tsx`, `DayDetails.tsx`, `StartOfMonth.tsx` | טפסים ודוחות |
| `pages/*.tsx` | מסך לכל נתיב (בטבלה הבאה). `Simulator.tsx` מייבא את `src/analytics/simulator.ts` ישירות (מותר ב-`server.fs.allow` של `web/vite.config.ts` — רק הקובץ הזה) |
| `lib/visuals.tsx`, `lib/utils.ts` | אייקונים לקטגוריות, צבעים, `cn` |

---

## מסכים (נתיבי הממשק)

| נתיב | מסך | פרמטרים ב-URL |
|---|---|---|
| `/` | סקירה (במצב פשוט: נשאר להוציא החודש, הכנסות, הוצאות, בבנק, על מה הלך הכסף, התראות; במצב מלא: הכול) | |
| `/transactions` | תנועות | `cycle`, `search`, `category`, `account`, `kind` (גם כמה, למשל `expense,refund`), `review=1`, `charge`, `fixed=1/0` |
| `/fixed` | קבועות החודש | `#scheduled`, `#planned` |
| `/budgets` | תקציב | |
| `/seasonal` | קופה לאירועים צפויים | |
| `/maaser` | מעשרות (שורה בסקירה כשמופעל) | |
| `/iou` | הלוואות בין אנשים (מי חייב למי) | |
| `/reminders` | תזכורות ידניות ואוטומטיות | |
| `/month-close` | סגירת חודש ודוח חודשי (להדפסה) | `cycle` |
| `/simulator` | סימולטור: קיצוץ לפי קטגוריה, כדור שלג מול מפולת (לא נשמר כלום) | |
| `/health` | בדיקת תקינות (מספר אדום בתפריט = בעיות פתוחות) | |
| `/charge-moves` | מעבר כרטיס / בנק וביטול חיובים, עם אימות אחרי כל עדכון | |
| `/trends` | מגמות הוצאות (6 / 12 / 24 / מקסימום) | `parent`, `leaf` |
| `/cashflow` | תזרים ותחזית | |
| `/insights` | תובנות והתראות | |
| `/events` | אירועים ותגיות | `id` |
| `/businesses`, `/savings`, `/investments`, `/pension`, `/loans`, `/insurance`, `/categories` | | |
| `/logs` | יומן ותקלות | |
| `/settings` | הגדרות | `#members`, `#accounts` |
| `/welcome` | אשף התחלה (דסקטופ) | |

הצ'אט מקשר למסכים האלה (`agent/CLAUDE.md` → "Links into the app"). מסך או פרמטר חדש — לעדכן גם שם.

---

## נתיבי API

כולם תחת `/api`. נתיבים שהצ'אט רשאי לקרוא: `API_PATHS` ב-`src/agent/mcp.ts`; לשנות: `WRITE_PATHS` (ובהגדרות רק `AGENT_SETTINGS`).

| תחום | נתיבים |
|---|---|
| כללי | `GET meta`, `PUT settings`, `GET/PUT fx`, `GET sync-status` |
| CRUD | `members`, `accounts` (PATCH), `businesses`, `tags`, `funds`, `assets`, `asset-snapshots`, `liabilities`, `liability-snapshots`, `scheduled` |
| תנועות | `GET transactions` (`fixed=1/0`: רק קבועות / רק משתנות), `GET transactions/export.csv`, `PATCH transactions/:id`, `POST transactions/bulk`, `GET transactions/:id/similar`, `POST transactions/manual`, `PUT transactions/:id/manual`, `DELETE transactions/:id` |
| כללים וקישורים | `GET/POST rules`, `DELETE rules/:id`, `GET/POST links`, `PATCH links/:id` |
| מתוכננות | `GET/POST planned`, `PUT/PATCH/DELETE planned/:id`, `POST planned/:id/match` |
| קופה לאירועים, סכום יומי | `GET/POST seasonal`, `PATCH/DELETE seasonal/:id`, `POST seasonal/:id/settle`, `PUT seasonal/pot`, `GET allowance` (גם בתוך `summary.allowance`) |
| סגירת חודש | `GET month-close?cycle=`, `PUT month-close/:cycle/checks` `{checkId, answer}`, `POST/DELETE month-close/:cycle`, `GET month-report?cycle=` |
| תזכורות | `GET/POST reminders` `{text, at: YYYY-MM-DDTHH:MM, repeat: once/monthly/yearly, href?}`, `PATCH/DELETE reminders/:id` (`done`) |
| הלוואות בין אנשים | `GET/POST iou`, `PATCH/DELETE iou/:id` (`done`), `POST iou/:id/payments` `{txnId}` או `{date, amount}`, `DELETE iou/:id/payments/:pid`, `PUT iou/:id/source` `{txnId}`, `POST iou/:id/reject` `{txnId}` |
| מעשרות | `GET maaser`, `PUT maaser/config` (שדות `MaaserConfig`) |
| מעבר כרטיס וביטולים | `GET charge-moves`, `GET charge-moves/candidates?from=`, `POST charge-moves` `{fromAccountId, toAccountId (null = ביטול), seriesIds, marked?}`, `PATCH charge-moves/:id` `{status: moved/todo, notes?}`, `DELETE charge-moves/:id` |
| בדיקת תקינות | `GET health`, `PUT health/ignore` `{id, ignore}` |
| סימולטור | `GET simulator/base` (הקלט; החישוב רץ בדפדפן), `GET simulator/debts?extra=&cpi=&fee=` (אותה השוואה בשרת, לצ'אט) |
| ניתוח | `summary`, `income`, `cashflow` (`cycles=N` / `max`), `cashflow/export.csv`, `forecast`, `cards/upcoming`, `month-plan`, `installments`, `recurring`, `budgets` (+`PUT`), `planning`, `alerts` (+`PATCH :id`), `recommendations` (+`POST state`), `networth`, `balance-history`, `coverage` (לכל חשבון), `history-range` (לכל חברה) |
| קטגוריות ואירועים | `GET/POST categories`, `PATCH/DELETE categories/:id`, `events`, `events/:id`, `events/:id/candidates`, `POST events/:id/transactions` |
| עסקים | `businesses/:id/report`, `businesses/:id/export.csv` |
| ביטוח, פנסיה, השקעות | `insurance` (+מסמכים), `pension`, `investments` (+`holdings`, `refresh`, `search`, `quote`) |
| ייבוא דוחות | `POST reports/upload?name=` (PDF / תמונה → `data/reports`), `POST pension/import`, `POST insurance/import` (JSON). הצ'אט רשאי רק `pension/import` |
| משיכה | `GET/POST scrape` (`{showBrowser, from}`), `POST scrape/otp`, `POST scrape/check`, `GET scrape/companies`, `GET scrape/runs`, `GET logs`, `GET browser`, `POST browser/download`, `POST pipeline` |
| צ'אט | `GET agent`, `POST agent/chat` (SSE), `GET agent/setup`, `GET agent/models`, `PUT/DELETE agent/gemini/key`, `POST agent/kiro/install`, `POST agent/kiro/login` |

---

## מסד הנתונים (SQLite, `bank.db`)

טבלאות: `accounts`, `transactions`, `transaction_tags`, `transaction_links`, `categories`, `category_aliases`, `category_rules`,
`members`, `businesses`, `tags`, `budgets`, `balances`, `fx_rates`, `recurring_series`, `scheduled_items`, `planned_items`,
`sinking_funds` (`kind`: general / seasonal), `seasonal_events`, `assets`, `asset_snapshots`, `asset_deposits`, `pension_reports`, `liabilities`, `liability_snapshots`,
`insurance_policies`, `insurance_documents`, `holdings`, `quotes`, `quote_history`, `alerts` (`href`: המסך שמטפל בהתראה; ההתראה בדסקטופ פותחת אותו), `recommendation_states`,
`month_closes` (חודש שנסגר: צילום מצב + חתימה), `month_close_checks` (התשובות לבדיקות), `charge_moves` (חיוב קבוע שמועבר או מבוטל: todo / moved / verified / failed), `iou`, `iou_payments` (הלוואות בין אנשים והחזרים), `reminders`, `scrape_runs`, `settings`, `schema_version`.

שינוי סכמה = מיגרציה חדשה בסוף `src/db/migrations.ts` (הבאה: 24) + עדכון הרשימה הזו.

### מפתחות `settings`
| מפתח | משמעות |
|---|---|
| `cycle_start_day` | היום שבו מתחיל החודש |
| `balance_buffer` | יתרה מינימלית רצויה |
| `scrape_months_back` | כמה חודשים אחורה לעדכן (1–24) |
| `category_api_url` | שירות סיווג חיצוני (מקבל תיאורי תנועות) |
| `agent_provider` | `claude` / `gemini` / `kiro` |
| `agent_model_claude`, `agent_model_gemini`, `agent_model_kiro` | המודל לכל כלי |
| `scrape_time`, `scrape_catch_up` | משיכה יומית בדסקטופ |
| `notify_scrape`, `notify_alerts` | התראות בדסקטופ |
| `onboarding_done` | האשף הושלם |
| `date_display` | `gregorian` / `both`: תאריך עברי ליד הלועזי ברשימת התנועות |
| `ui_mode` | `simple` (ברירת מחדל: תפריט מקוצר וסקירה פשוטה) / `full` |
| `nav_pinned` | JSON: נתיבי מסכים שהוצמדו לתפריט במצב פשוט (כשאין ערך: `/maaser` אם המעשרות פעילות) |
| `maaser_cfg` | JSON: הגדרות המעשרות (`enabled`, `percent`, `base` net/gross, `grossMonthly`, `donationCategoryIds`, `excludeCategoryIds`, `excludePatterns`, `startMonth`, `openingBalance`). נכתב רק דרך `PUT /api/maaser/config` |
| `health_ignore` | JSON: מזהה בדיקה ← הנוסח שהמשתמש הסתיר (נכתב רק דרך `PUT /api/health/ignore`) |

הצ'אט יכול לשנות רק `cycle_start_day`, `balance_buffer`, `scrape_months_back`.

---

## אחסון בדפדפן (`localStorage`)

| מפתח | קובץ | תוכן |
|---|---|---|
| `agent-chat` | `components/AgentChat.tsx` | השיחה האחרונה ומזהה הסשן |
| `scrape.showBrowser` | `components/ScrapeButton.tsx` | האם להציג את חלון הדפדפן במשיכה |

---

## הגשר לדסקטופ (`window.familycfo`, ערוצי IPC)

`version` (`app:version`) · `bankLogins.list/store/save/remove` (`logins:*`) · `onPasswordRequest` / `answerPassword` (`password-request`, `logins:password`) ·
`onNavigate` (`navigate`) · `checkForUpdates` (`app:check-updates`). פרטי הכניסה נכנסים ולא יוצאים; הרשימה מחזירה שמות שדות בלבד.

---

## משתני סביבה

| משתנה | משמעות |
|---|---|
| `BANK_DB` | קובץ המסד (ברירת מחדל `bank.db`) |
| `PORT`, `WEB_PORT` | פורטים (4310 / 5180) |
| `ACCOUNTS_FILE` | קובץ פרטי הכניסה |
| `SCRAPE_FROM` (`YYYY-MM-DD` / `max`), `SCRAPE_MONTHS`, `SCRAPE_ONLY`, `SHOW_BROWSER`, `SCHEDULE` | משיכה |
| `AGENT_PROVIDER`, `CLAUDE_PATH`, `KIRO_PATH`, `GEMINI_API_KEY` | הצ'אט |
| `LOG_DIR`, `LOG_KEEP_DAYS`, `LOG_LEVEL` | יומן |
| `POLICIES_DIR`, `REPORTS_DIR`, `BROWSER_DIR`, `CATEGORY_API_URL` | תיקיות ושירותים |
| `HOUSEHOLD_HOME`, `HOUSEHOLD_APP_DIR`, `HOUSEHOLD_DESKTOP`, `HOUSEHOLD_WEB_DIST`, `HOUSEHOLD_MCP_SCRIPT`, `HOUSEHOLD_GEMINI_SCRIPT`, `HOUSEHOLD_IMPORT_FROM`, `HOUSEHOLD_API`, `HOUSEHOLD_DOC_MODE`, `HOUSEHOLD_POLICIES_DIR`, `HOUSEHOLD_REPORTS_DIR` | פנימיים לדסקטופ ולצ'אט |

---

## תלויות חיצוניות מרכזיות

שרת: `fastify`, `better-sqlite3`, `unpdf` (טקסט מ-PDF לצ'אט עם Kiro), `israeli-bank-scrapers`, `puppeteer` / `@puppeteer/browsers`, `node-cron`, `zod`, `electron-updater`.
פיתוח ובנייה: `typescript`, `tsx`, `vitest`, `concurrently`, `electron`, `electron-builder`, `esbuild`, `@google/gemini-cli` (נארז עם הדסקטופ).
ממשק (`web/package.json`): `react`, `react-router-dom`, `@tanstack/react-query`, `tailwindcss`, `radix-ui`, `lucide-react`, `motion`, `recharts`.
שירותים מבחוץ: הבנקים וחברות האשראי, בנק ישראל (שערים), Yahoo Finance (סמלים בלבד), ספק ה-AI שנבחר, `category_api_url` אם הוגדר.
