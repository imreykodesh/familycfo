---
name: import-document
description: Import an uploaded report into the app — a pension / study-fund / provident-fund report (agent's periodic report, the pension clearing house), an insurance summary (Har HaBituach, a policy page), or a mortgage balance report / loan amortization schedule (דוח יתרות, לוח סילוקין). Use when the user asks to import / load / "תייבא" a file in ./docs/reports/.
---

# Importing an uploaded report

The user uploaded the file from a screen of the app; it is in `./docs/reports/<file>` (the message names it).
The goal: the numbers in the document end up in the app, without the user doing anything else.

1. `Read` the file. Long PDFs: the summary pages first, then the detailed tables you need.
2. Decide what it is (pension / insurance / loan or mortgage). If it isn't any of these, or it's unreadable, say so and stop.
3. Look up what exists already, so you update instead of duplicating: `/meta` (members), `/pension`, `/insurance`, `/liabilities`.
   The owner of the report must be a member: match the name in the document to a member in `/meta`. If it's unclear whose it
   is, ask (quick-reply buttons with the member names) before importing.
4. Import (below). Never invent a number: a field the document doesn't state is left out.
5. Answer in Hebrew: in a few lines what was imported (products / policies / loans, totals, the "as of" date), what you couldn't
   read, and a link to the screen (`/pension`, `/insurance`, `/loans`). If the API returned an error, say what it was — never
   claim an import that failed.

## Pension, study funds, provident funds → `POST /pension/import`

One call with the whole report. It is idempotent (same report again = updated, not duplicated), and it refuses a report whose
products don't add up to `summary.totalSavings` (±2) — then re-check the products you read, don't adjust the total to fit.

```json
{
  "asOf": "2026-06-30", "member": "<member name exactly as in /meta>", "source": "<who produced it, e.g. the agency / המסלקה הפנסיונית>",
  "file": "<the file name in docs/reports>", "issuedAt": "2026-07-15",
  "agent": { "name": "", "agency": "", "phone": "", "email": "" },
  "summary": { "totalSavings": 0, "ytdReturnPct": 0, "lifeHealthMonthlyPremium": 0,
    "byProductType": [{ "name": "", "amount": 0, "pct": 0 }], "byProvider": [{ "name": "", "amount": 0, "pct": 0 }],
    "tradedPct": { "traded": 0, "nonTraded": 0 }, "exposurePct": { "stocks": 0, "abroad": 0, "foreignCurrency": 0 },
    "assetMixPct": [{ "name": "", "pct": 0 }], "monthlyDeposits": { "pension": 0, "total": 0 },
    "expectedAnnuity": { "pensionWithoutDeposits": 0, "pensionWithDeposits": 0, "managers": 0, "totalWithoutDeposits": 0 },
    "coverage": { "disability": 0, "death": 0, "noInfo": [] } },
  "products": [{
    "type": "pension | keren_hishtalmut | kupat_gemel (managers' insurance = pension)",
    "name": "", "provider": "", "policyNumber": "", "balance": 0, "status": "active | inactive",
    "employer": "", "joinDate": "YYYY-MM-DD", "feeDeposit": 0, "feeBalance": 0, "regularDeposit": 0,
    "insuredSalary": 0, "lastDeposit": "YYYY-MM-DD", "expectedAnnuity": 0, "expectedAnnuityWithDeposits": 0,
    "tracks": [{ "name": "", "share": 0, "balance": 0, "returns": [null, null, null, null, null, null, null] }],
    "components": { "pitzuyim": 0, "tagmulim": 0, "capital": 0 },
    "coverages": [{ "name": "", "pct": 0, "monthly": 0 }], "coverageCost": { "disability": 0, "survivors": 0 },
    "deposits": [["valueDate", "YYYY-MM salary month", 0, 0, 0, 0, 0]]
  }],
  "insurance": [{ "name": "", "type": "life | disability | health | ...", "insurer": "", "policyNumber": "", "premium": 0,
    "premiumFrequency": "monthly | yearly | one_time", "startDate": "YYYY-MM-DD" }]
}
```

- Required: `asOf`, `member`, `source`, `summary.totalSavings`, and per product `type`, `name`, `provider`, `policyNumber`,
  `balance`, `status`. Leave out every other key the report doesn't state (in `summary` too — don't send zeros for missing data).
- Fees in % (`feeDeposit` of each deposit, `feeBalance` of the balance a year). Track `returns` = 7 values in %: last month, YTD,
  12 months, 3 years, 5 years, 3-year average, 5-year average (`null` when not given).
- `deposits` rows: value date, salary month, salary, employee, employer, severance, total (`null` for a missing value).

## Insurance → `/insurance`

For each policy in the document: find it in `/insurance` by insurer + policy number. Found → `PATCH /insurance/ID` with the fields
the document states; not found → `POST /insurance` (`name`, `type`, `insurer`, `policyNumber`, `insuredMemberId`, `premium`,
`premiumFrequency`, `startDate`, `endDate`, `coverage`, `agentName`, `agentPhone`, `notes`). `type`: health, life, nursing,
critical_illness, disability, car, home, mortgage, travel, pet, other. Note in `notes` which document the details came from.

## Mortgage / loan (balance report, amortization schedule) → `/liabilities`

- One liability per loan. A mortgage with several tracks (מסלולים) is **one** liability (the bank charges it as one payment):
  `originalPrincipal` and the balance = the sum of the tracks, `monthlyPayment` = the total monthly payment, `interestRate` = the
  balance-weighted average rate, `indexType` = the tracks' indexation if all share it (`prime`, `cpi`, `fixed`), else `other`,
  `endDate` = the last track's end. List the tracks in `notes`, one line each: name, indexation, rate, balance, end date.
- Find an existing one in `/liabilities` by lender (+ name / loan number in `notes`). Found → `PATCH /liabilities/ID` with what the
  report states. Not found → `POST /liabilities` `{name ("משכנתא — <bank>" / "הלוואה — <lender>"), type: "mortgage" | "loan",
  lender, ownerMemberId (null = shared), originalPrincipal, interestRate, indexType, startDate, endDate, monthlyPayment,
  paymentDay, notes}`.
- The balance: `POST /liability-snapshots` `{liabilityId, date: <the report's "as of" date>, balance}` (the payoff balance,
  יתרה לסילוק, including indexation when the report gives it). An amortization schedule: the balance after the last payment
  before today, dated that payment's date.
- New liability with a payment day: find the bank account it is paid from (`/meta` accounts; `/transactions?search=<lender>` shows
  the repayment rows and their description). When it's clear, set `bankAccountId` and `matchPattern` (the text of the bank row),
  and add it to the forecast: `POST /scheduled` `{name, kind: "mortgage" | "loan", amount: -monthlyPayment, dayOfMonth: paymentDay,
  bankAccountId, memberId, matchPattern, liabilityId, endDate, status: "confirmed"}` — only if `/scheduled` has no item for it yet.
