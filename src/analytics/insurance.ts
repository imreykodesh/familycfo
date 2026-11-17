import type { DB } from '../db/connection.js';
import { addDays, round, SHARED_MEMBER_ID, today } from './common.js';

type Row = Record<string, any>;

/** Insurance-looking charges of the last year: by category ("ביטוח…") or by a policy's pattern. */
export function insuranceCharges(db: DB, asOf = today()): Row[] {
  return db.prepare(`
    SELECT t.id, t.description, t.date, t.account_id, -t.charged_amount AS amount, t.category_id
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN categories p ON p.id = c.parent_id
    WHERE t.excluded = 0 AND t.kind IN ('expense', 'refund') AND t.date >= ? AND t.date <= ?
      AND (c.name LIKE '%ביטוח%' OR p.name LIKE '%ביטוח%' OR EXISTS (
        SELECT 1 FROM insurance_policies ip WHERE ip.archived = 0 AND ip.match_pattern IS NOT NULL AND ip.match_pattern <> ''
          AND instr(lower(t.description), lower(ip.match_pattern)) > 0))
    ORDER BY t.date`).all(addDays(asOf, -365), `${asOf}T23:59:59`) as Row[];
}

/** A charge is the policy's when its text matches — and it's from the paying account, if one is set. */
export const policyMatches = (policy: Row, charge: Row) =>
  !!policy.match_pattern?.trim() && charge.description.toLowerCase().includes(String(policy.match_pattern).trim().toLowerCase())
  && (!policy.payment_account_id || charge.account_id === policy.payment_account_id);

/** Normalized monthly cost of a policy's premium. */
export const monthlyPremium = (p: Row) => (p.premium == null ? 0 : p.premium_frequency === 'yearly' ? p.premium / 12 : p.premium_frequency === 'one_time' ? 0 : p.premium);

export interface InsuranceInsight {
  key: string;
  title: string;
  detail: string;
  monthlySaving: number;
  examples: { description: string; amount: number }[];
}

/** Car spend that shows the car is in use: fuel / charging and parking (by category, or a known operator). */
const CAR_USE = /דלק|חני|פנגו|סלופארק|cellopark|pango|פז|סונול|דור אלון|ten |yellow/i;

/**
 * Insurance tips from simple rules over the policies and the rows (shown with the recommendations):
 * - a member with a salary and no disability (אובדן כושר עבודה) policy;
 * - two home / structure policies;
 * - a nursing (סיעודי) policy whose charges went up ≥ 10% within the year;
 * - a car policy while there's been no fuel or parking for 3 months (but there was before).
 */
export function insuranceInsights(db: DB, asOf = today()): InsuranceInsight[] {
  const policies = db.prepare(`SELECT * FROM insurance_policies WHERE archived = 0`).all() as Row[];
  const out: InsuranceInsight[] = [];

  // 1. salary, no disability insurance (a policy for the whole family counts for everyone)
  const earners = db.prepare(`SELECT DISTINCT a.owner_member_id AS id, m.name FROM recurring_series s
    JOIN accounts a ON a.id = s.account_id JOIN members m ON m.id = a.owner_member_id
    WHERE s.active = 1 AND s.kind = 'salary' AND a.owner_member_id IS NOT NULL AND a.owner_member_id != ?`).all(SHARED_MEMBER_ID) as { id: number; name: string }[];
  const disability = policies.filter(p => p.type === 'disability');
  for (const m of earners) {
    if (disability.some(p => p.insured_member_id == null || p.insured_member_id === m.id)) continue;
    out.push({
      key: `insurance:no-disability:${m.id}`, title: `ל${m.name} יש משכורת ואין ביטוח אובדן כושר עבודה`,
      detail: 'אובדן כושר עבודה משלם חלק מהמשכורת אם לא אפשר לעבוד בגלל מחלה או תאונה. לפעמים הוא כבר כלול בקרן הפנסיה: כדאי לבדוק בדוח הפנסיה ובהר הביטוח לפני שקונים.',
      monthlySaving: 0, examples: [],
    });
  }

  // 2. two home / structure policies
  const homes = policies.filter(p => p.type === 'home');
  if (homes.length >= 2) {
    const cheaper = Math.min(...homes.map(monthlyPremium));
    out.push({
      key: `insurance:double-home:${homes.map(p => p.id).sort().join('-')}`, title: `${homes.length} ביטוחי דירה / מבנה`,
      detail: 'הרבה פעמים ביטוח המבנה של המשכנתא מכפיל ביטוח דירה שנקנה בנפרד. כדאי לבדוק מה כל אחד מכסה ולבטל כפילות.',
      monthlySaving: round(cheaper), examples: homes.map(p => ({ description: p.name, amount: round(monthlyPremium(p)) })),
    });
  }

  // 3. nursing insurance getting more expensive: the last charges vs the first ones of the year
  const charges = insuranceCharges(db, asOf);
  for (const p of policies.filter(p => p.type === 'nursing')) {
    const paid = charges.filter(c => policyMatches(p, c) && c.amount > 0);
    if (paid.length < 4) continue;
    const first = (paid[0].amount + paid[1].amount) / 2;
    const last = (paid.at(-1)!.amount + paid.at(-2)!.amount) / 2;
    if (first > 0 && last >= first * 1.1) {
      out.push({
        key: `insurance:nursing-up:${p.id}:${paid.at(-1)!.date.slice(0, 7)}`, title: `הביטוח הסיעודי „${p.name}" התייקר ב-${Math.round((last / first - 1) * 100)}% בשנה`,
        detail: 'ביטוח סיעודי פרטי מתייקר עם הגיל. כדאי לבדוק אם יש כיסוי סיעודי בקופת החולים (שב"ן) או בביטוח קבוצתי, ולהשוות הצעות לפני שהמחיר ממשיך לעלות.',
        monthlySaving: round(last - first), examples: [{ description: `מ-₪${Math.round(first)} ל-₪${Math.round(last)} בחודש`, amount: 0 }],
      });
    }
  }

  // 4. car insurance, no sign the car is used for 3 months (but there was before, so it isn't just missing history)
  const cars = policies.filter(p => p.type === 'car');
  if (cars.length) {
    const uses = db.prepare(`SELECT MAX(substr(t.date, 1, 10)) AS last, MIN(substr(t.date, 1, 10)) AS first, COUNT(*) AS n FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN categories pc ON pc.id = c.parent_id
      WHERE t.excluded = 0 AND t.kind = 'expense'
        AND (c.name LIKE '%דלק%' OR c.name LIKE '%חני%' OR pc.name LIKE '%דלק%')`).get() as { last: string | null; first: string | null; n: number };
    const byText = (db.prepare(`SELECT description, substr(date, 1, 10) AS day FROM transactions WHERE excluded = 0 AND kind = 'expense' AND date >= ?`)
      .all(addDays(asOf, -400)) as { description: string; day: string }[]).filter(t => CAR_USE.test(t.description));
    const lastUse = [uses.last, ...byText.map(t => t.day)].filter(Boolean).sort().at(-1) ?? null;
    const firstUse = [uses.first, ...byText.map(t => t.day)].filter(Boolean).sort()[0] ?? null;
    if (lastUse && firstUse && lastUse < addDays(asOf, -90) && firstUse < addDays(asOf, -120)) {
      for (const p of cars) {
        out.push({
          key: `insurance:car-unused:${p.id}:${lastUse.slice(0, 7)}`, title: `ביטוח רכב „${p.name}" — ואין דלק או חניה מאז ${lastUse.split('-').reverse().join('.')}`,
          detail: 'אם הרכב נמכר או לא בשימוש, אפשר לבטל את הביטוח או להקטין אותו (ולקבל החזר על התקופה שנשארה).',
          monthlySaving: round(monthlyPremium(p)), examples: [],
        });
      }
    }
  }
  return out;
}
