---
name: categorize-transactions
description: Suggest categories for the transactions that have none and, once the user agrees, save them as rules so future rows are categorized too. Use for "סווג בעזרת AI", "תסווג את התנועות", "תנועות בלי קטגוריה", "ללא קטגוריה", "מה זה X ולאיזו קטגוריה".
---

# Categorize uncategorized transactions

The app already tried rules, the same merchant, a keyword index and the card company's category. What's left needs
judgment: you know Israeli merchants, chains, institutions and nonprofits. Propose first, change only after a yes.

## 1. What's left

```sql
SELECT t.description, a.kind AS account_kind, t.kind, t.source_category,
       COUNT(*) AS n, ROUND(SUM(t.charged_amount)) AS total, MIN(t.id) AS sample_id, MAX(substr(t.date, 1, 10)) AS last
FROM transactions t JOIN accounts a ON a.id = t.account_id
WHERE t.category_id IS NULL AND COALESCE(t.category_source, '') != 'manual' AND t.excluded = 0
  AND t.kind IN ('expense', 'refund', 'income')
GROUP BY 1, 2, 3, 4 ORDER BY n DESC, ABS(total) DESC LIMIT 150;
```

`category_source = 'manual'` with no category = the user cleared it on purpose: never touch those. Transfers, card bills
and savings rows aren't spend or income, so they're left out. Descriptions that differ only by numbers / branch codes /
punctuation are the same merchant: treat them as one.

`/categories` — the household's own tree (name, parent, kind). Use only these categories (prefer the most specific
leaf) and never create one unless the user asks.

## 2. Decide, honestly

- **Confident**: the name says what it is — a known chain or company, an institution (עירייה, תאגיד מים, קופת חולים,
  בית חולים), a type of business in the name (מסעדה, מספרה, מוסך, פיצה), a nonprofit (ע"ר, עמותה) that isn't a school.
- **Not sure** → don't guess; list it as a question. Typical: a person's name (a transfer to / from someone, Bit, PayBox),
  a cheque, a short or cryptic name, PayPal / foreign rows with no clear merchant.
- Direction: money in (income on a bank) only to an `income` category; money out (or a refund on a card) only to an
  `expense` category. Never a `transfer` / `savings` / `card_payment` category unless the user says so — it changes what
  counts as spend.

## 3. Propose (no changes yet)

In Hebrew:
- One line: how many rows have no category, and how many you can categorize.
- A table: merchant | rows | ₪ | → category (a few words why, only when it isn't obvious). Biggest first. More than
  ~40 merchants: the biggest 40 now, say how many remain.
- "לא בטוח" — a short list of the ones you won't guess, each with the question that would settle it.
- Quick replies: `[✓ לסווג ולשמור ככללים](ask:כן, תסווג לפי ההצעה ותשמור ככללים)` and, if relevant,
  `[לסווג בלי חלק מהם](ask:תסווג חוץ מ: )`.

## 4. After a yes: one rule per merchant

`POST /rules` `{fromTransactionId: sample_id, setCategoryId, applyToExisting: true}` — the API saves the merchant's
name without numbers and codes, and categorizes every matching row now and in the future.

Before each rule, make sure it matches only this merchant:
- If the name without numbers is too general (`PAYPAL *HAIM4723 …` and `PAYPAL *CHIME2155 …` would both become
  "paypal"; a single short word like "מקס"), send `pattern` instead of `fromTransactionId`: the distinguishing text,
  lower case, e.g. `{pattern: "paypal *haim", setCategoryId, applyToExisting: true}`.
- A rule also re-categorizes rows that already have another (automatic) category. Check first:
  `SELECT c.name, COUNT(*) FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE lower(t.description) LIKE '%<pattern>%' GROUP BY 1`
  — if it hits rows of a different category, use a more specific pattern or skip it and say so.

Then `POST /pipeline` `{}` (similar merchants pick up the new categories).

## 5. Report

- How many rows got a category, and how many are still without one: `[התנועות שנשארו בלי קטגוריה](/transactions?review=1)`.
- Any rule that failed (the API's error), and the "לא בטוח" questions again, briefly.
- If merchants remain beyond the first batch: `[להמשיך לסווג](ask:סווג בעזרת AI את התנועות שנשארו בלי קטגוריה)`.
