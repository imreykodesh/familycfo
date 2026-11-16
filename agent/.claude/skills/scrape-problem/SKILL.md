---
name: scrape-problem
description: Explain why updating from a bank or credit card failed and what to do. Use for "למה העדכון נכשל", "הבנק לא מתעדכן", "מה אומרת השגיאה", "יש בעיה בסריקה", or a pasted scrape error.
---

# Scrape problem

1. `/sync-status` — which companies failed last time, how many times in a row, and the app's own `explanation`.
2. `/scrape/runs?company=ID&limit=10` for the failing company — when it last worked, whether the error changed, and the
   `pageState` of the failed runs (what the bank's page said when it closed: a password message, a maintenance notice, an SMS screen).
3. If it's still unclear: `/logs?level=warn&days=2&search=<company id>` for the lines around the failure.

Answer (Hebrew):
- What happened, in one sentence, and since when ("מאז 12.10, 3 ניסיונות").
- What to do — the one or two concrete steps (fix the password in accounts.json, enter the SMS code in time, wait an hour, update
  israeli-bank-scrapers, install Chrome). If the login is wrong or the user is blocked, say not to retry until it's fixed.
- If only one company fails and the rest work, say so: the problem is with that site / login, not the app.
