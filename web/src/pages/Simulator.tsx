import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, Calculator, CalendarClock, Landmark, Mountain, PiggyBank, Scissors, Snowflake, Target, Trash2, TriangleAlert } from 'lucide-react';
import { api, qs, type SimulatorBase } from '../api';
import { useFilters } from '../state';
import { money, monthName, todayIso } from '../format';
import { Empty, ErrorBox, Field, Loading, Money, PageHeader, Picker, SectionTitle, Stat } from '../components/ui';
import { MultiLine } from '../components/charts';
import { cn } from '@/lib/utils';
// the same pure functions the API uses (GET /simulator/debts), run here so the sliders answer at once
import { compareDebtPlans, cutImpact, MAX_MONTHS, type DebtOrder, type DebtPlan } from '../../../src/analytics/simulator';

/** YYYY-MM, n months from this month */
function monthKeyIn(n: number): string {
  const [y, m] = todayIso().slice(0, 7).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
const shortMonth = (n: number) => { const k = monthKeyIn(n); return `${k.slice(5)}/${k.slice(0, 4)}`; };
const monthsText = (n: number) => (n === 1 ? 'חודש אחד' : `${n} חודשים`);
const yearsText = (n: number) => (n < 12 ? monthsText(n) : `${monthsText(n)} (כ-${(n / 12).toFixed(1).replace(/\.0$/, '')} שנים)`);

const METHODS: { key: 'baseline' | DebtOrder; title: string; sub: string; icon: typeof Snowflake; color: string }[] = [
  { key: 'baseline', title: 'בלי שינוי', sub: 'רק ההחזרים הקבועים, כל חוב לחוד', icon: Landmark, color: 'var(--chart-4)' },
  { key: 'snowball', title: 'כדור שלג', sub: 'קודם החוב עם היתרה הקטנה', icon: Snowflake, color: 'var(--chart-1)' },
  { key: 'avalanche', title: 'מפולת', sub: 'קודם החוב עם הריבית הגבוהה', icon: Mountain, color: 'var(--chart-2)' },
];

export default function Simulator() {
  const { filters } = useFilters();
  const query = { member: filters.memberId };
  const { data, isLoading, error } = useQuery({ queryKey: ['simulator-base', query], queryFn: () => api.get<SimulatorBase>(`/simulator/base${qs(query)}`) });

  // nothing on this screen is saved: all of it is local state
  const [cuts, setCuts] = useState<Record<number, number>>({});
  const [extra, setExtra] = useState(0);
  const [cpi, setCpi] = useState<number | null>(null);
  const [fee, setFee] = useState(0);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());

  const cutTotal = Object.values(cuts).reduce((s, v) => s + v, 0);
  const impact = useMemo(() => cutImpact(cutTotal, data?.goals ?? []), [cutTotal, data]);
  const cpiAnnual = cpi ?? data?.assumptions.cpiAnnual ?? 0;
  const debts = useMemo(() => (data?.debts ?? []).filter(d => !excluded.has(d.id)), [data, excluded]);
  const plans = useMemo(() => compareDebtPlans(debts, extra, { cpiAnnual, prepaymentFeePct: fee }), [debts, extra, cpiAnnual, fee]);

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;

  const byId = new Map(data.categories.map(c => [c.categoryId, c]));
  const catLabel = (c: SimulatorBase['categories'][number]) => (c.parentName ? `${c.parentName} › ${c.name}` : c.name);
  const available = data.categories.filter(c => !(c.categoryId in cuts));
  const anyCpi = debts.some(d => d.cpiLinked);
  const mostlyFixed = (c: SimulatorBase['categories'][number]) => c.fixed > c.average * 0.5;

  const longest = Math.min(MAX_MONTHS, Math.max(...[plans.baseline, plans.snowball, plans.avalanche].map(p => p.balances.length - 1)), 480);
  const chart = Array.from({ length: longest + 1 }, (_, i) => ({
    label: shortMonth(i),
    baseline: plans.baseline.balances[i] ?? null,
    snowball: plans.snowball.balances[i] ?? null,
    avalanche: plans.avalanche.balances[i] ?? null,
  }));

  return (
    <>
      <PageHeader icon={Calculator} title="סימולטור"
        subtitle="מה יקרה אם נקצץ בקטגוריה, ובאיזה סדר כדאי להחזיר את החובות. שום דבר כאן לא נשמר ולא משנה את הנתונים." />

      {/* ---- cutting a category ---- */}
      <div className="card">
        <SectionTitle icon={Scissors} color="var(--chart-3)">קיצוץ לפי קטגוריה</SectionTitle>
        <p className="mb-3 text-sm text-fg-subtle">
          {data.months.count > 0
            ? <>הממוצע של כל קטגוריה מחושב על {data.months.count} החודשים המלאים האחרונים ({monthName(data.months.from!.slice(0, 7))} – {monthName(data.months.to!.slice(0, 7))}).</>
            : 'עוד אין חודש מלא עם נתונים, אז אין ממוצעים לקטגוריות.'}
        </p>

        {available.length > 0 && (
          <div className="mb-4 max-w-md">
            <Picker value={null} placeholder="+ בחרו קטגוריה לקיצוץ" searchable
              onChange={v => { if (v) { const c = byId.get(Number(v)); if (c) setCuts({ ...cuts, [c.categoryId]: Math.round(c.average * 0.2 / 10) * 10 }); } }}
              options={[...available.filter(c => !mostlyFixed(c)), ...available.filter(mostlyFixed)].map(c => ({
                value: String(c.categoryId), label: `${catLabel(c)} · ${money(c.average)} בחודש`, keywords: [c.name, c.parentName ?? ''],
                group: mostlyFixed(c) ? 'בעיקר חיובים קבועים' : 'הוצאות משתנות',
              }))} />
          </div>
        )}

        {Object.keys(cuts).length === 0 ? (
          data.categories.length > 0 && <Empty>בחרו קטגוריה, וגררו את המחוון כדי לראות כמה זה חוסך בחודש ובשנה, ובכמה זה מקדים את יעדי החיסכון. אפשר לצבור כמה קטגוריות.</Empty>
        ) : (
          <div className="space-y-3">
            {Object.entries(cuts).map(([id, value]) => {
              const c = byId.get(Number(id));
              if (!c) return null;
              const max = Math.max(10, Math.ceil(c.average / 10) * 10);
              return (
                <div key={id} className="rounded-lg border border-line-soft px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="font-medium">{catLabel(c)}</span>
                      <span className="ms-2 text-xs text-fg-subtle">ממוצע <Money value={c.average} /> בחודש{mostlyFixed(c) && ' · רובו קבוע'}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm">לקצץ</span>
                      <input className="input num w-28" type="number" min={0} max={max} step={10} value={value} aria-label={`כמה לקצץ ב${c.name}`}
                        onChange={e => setCuts({ ...cuts, [id]: Math.max(0, Math.min(max, Number(e.target.value) || 0)) })} />
                      <span className="w-12 text-xs text-fg-subtle num">{c.average > 0 ? `${Math.round((value / c.average) * 100)}%` : ''}</span>
                      <button className="btn-ghost btn-icon" aria-label="הסרה" onClick={() => { const n = { ...cuts }; delete n[Number(id)]; setCuts(n); }}><Trash2 /></button>
                    </div>
                  </div>
                  <input type="range" className="mt-2 w-full accent-primary" min={0} max={max} step={10} value={value} aria-label={`מחוון קיצוץ ${c.name}`}
                    onChange={e => setCuts({ ...cuts, [id]: Number(e.target.value) })} />
                </div>
              );
            })}
          </div>
        )}

        {cutTotal > 0 && (
          <>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 md:gap-4">
              <Stat index={0} icon={PiggyBank} color="var(--chart-2)" label="חיסכון בחודש" value={impact.monthly} tone="good" />
              <Stat index={1} icon={CalendarClock} color="var(--chart-5)" label="חיסכון בשנה" value={impact.yearly} tone="good" />
            </div>
            <div className="mt-4">
              <div className="label mb-2 flex items-center gap-1.5"><Target className="h-3.5 w-3.5" />יעדי חיסכון — אם כל הקיצוץ ילך ליעד</div>
              {impact.goals.length === 0 ? (
                <p className="text-sm text-fg-subtle">אין קופות עם יעד. אפשר להגדיר סכום יעד ב<Link className="text-primary hover:underline" to="/savings">חיסכון וקופות</Link>.</p>
              ) : (
                <div className="space-y-1.5">
                  {impact.goals.map(g => (
                    <div key={g.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm">
                      <span className="font-medium">{g.name} <span className="text-xs font-normal text-fg-subtle">· חסרים <Money value={g.remaining} /></span></span>
                      <span>
                        {g.remaining === 0 ? 'היעד הושג'
                          : g.monthsEarlier != null && g.monthsWithCut != null
                            ? <>{g.monthsNow != null && <span className="text-fg-subtle">היום: {monthsText(g.monthsNow)} · </span>}עם הקיצוץ: {monthsText(g.monthsWithCut)} <span className="font-semibold text-positive">({monthsText(g.monthsEarlier)} מוקדם יותר)</span></>
                            : g.monthsWithCut != null && <>היום לא מפרישים אליה. עם הקיצוץ: {monthsText(g.monthsWithCut)}, ב{monthName(monthKeyIn(g.monthsWithCut))}</>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ---- repaying debts ---- */}
      <div className="card mt-4">
        <SectionTitle icon={Landmark} color="var(--chart-6)">החזר חובות: כדור שלג מול מפולת</SectionTitle>
        {data.debts.length === 0 ? (
          <Empty>
            {data.skipped.length ? 'להלוואות שהוגדרו חסר פרט כדי לחשב אותן (רשימה למטה).' : 'עוד לא הוגדרו הלוואות.'}{' '}
            <Link className="text-primary hover:underline" to="/loans">להלוואות ומשכנתא</Link>
          </Empty>
        ) : (
          <>
            <p className="mb-3 text-sm text-fg-subtle">
              כמה להוסיף כל חודש מעבר להחזרים הקבועים. בשתי השיטות, ההחזר של חוב שנסגר עובר לחוב הבא בתור.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="תוספת בחודש (₪)">
                <div className="flex gap-2">
                  <input className="input num" type="number" min={0} step={100} value={extra} onChange={e => setExtra(Math.max(0, Number(e.target.value) || 0))} />
                  <button className="btn shrink-0" disabled={cutTotal <= 0} onClick={() => setExtra(cutTotal)} title="להעביר לכאן את סכום הקיצוץ">
                    <ArrowDownToLine />מהקיצוץ{cutTotal > 0 && <span className="num">{money(cutTotal)}</span>}
                  </button>
                </div>
              </Field>
              {anyCpi && (
                <Field label="מדד משוער בשנה (%)">
                  <input className="input num" type="number" step={0.1} value={cpiAnnual} onChange={e => setCpi(Number(e.target.value) || 0)} />
                </Field>
              )}
              <Field label="עמלת פירעון מוקדם משוערת (%, רשות)">
                <input className="input num" type="number" min={0} step={0.1} value={fee} onChange={e => setFee(Math.max(0, Number(e.target.value) || 0))} />
              </Field>
            </div>
            <input type="range" className="mt-3 w-full accent-primary" min={0} max={Math.max(5000, Math.ceil(extra / 1000) * 1000)} step={50} value={extra}
              aria-label="מחוון תוספת חודשית" onChange={e => setExtra(Number(e.target.value))} />

            <div className="scroll-x mt-3"><table className="table">
              <thead><tr><th>לכלול</th><th>חוב</th><th className="text-end">יתרה</th><th>ריבית</th><th className="text-end">החזר חודשי</th></tr></thead>
              <tbody>
                {data.debts.map(d => (
                  <tr key={d.id} className={excluded.has(d.id) ? 'opacity-50' : ''}>
                    <td><input type="checkbox" className="accent-primary" checked={!excluded.has(d.id)} aria-label={`לכלול את ${d.name}`}
                      onChange={() => { const n = new Set(excluded); n.has(d.id) ? n.delete(d.id) : n.add(d.id); setExcluded(n); }} /></td>
                    <td className="font-medium">{d.name}</td>
                    <td className="text-end"><Money value={d.balance} /><div className="text-xs text-fg-subtle">נכון ל-{d.balanceDate.slice(0, 10).split('-').reverse().join('.')}</div></td>
                    <td className="whitespace-nowrap"><span className="num">{d.annualRate}%</span>{d.cpiLinked && <span className="text-xs text-fg-subtle"> + מדד</span>}</td>
                    <td className="text-end"><Money value={d.monthlyPayment} /></td>
                  </tr>
                ))}
              </tbody>
            </table></div>

            {debts.length > 0 && (
              <>
                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3 md:gap-4">
                  {METHODS.map(m => <PlanCard key={m.key} method={m} plan={plans[m.key]} best={plans.best === m.key}
                    saving={m.key === 'baseline' ? null : plans.savings[m.key]} showIndex={anyCpi} showFees={fee > 0} />)}
                </div>
                <div className="mt-4">
                  <div className="label mb-1">יתרת החובות לאורך הזמן</div>
                  <MultiLine data={chart} series={METHODS.map(m => ({ key: m.key, name: m.title, color: m.color, dashed: m.key === 'baseline' }))} />
                </div>
              </>
            )}
          </>
        )}

        {data.skipped.length > 0 && (
          <p className="mt-3 text-xs text-fg-subtle">
            לא נכללו: {data.skipped.map(s => `${s.name} (${s.reason})`).join(', ')}. אפשר להשלים ב<Link className="text-primary hover:underline" to="/loans">הלוואות ומשכנתא</Link>.
          </p>
        )}
        <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-fg-subtle">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          אומדן לפי ההנחות: ריבית קבועה לאורך כל התקופה{anyCpi ? ', מדד קבוע בכל שנה' : ''}, ויתרה כפי שהוזנה. לפני פירעון מוקדם לבקש מהבנק דוח סילוקין.
        </p>
      </div>
    </>
  );
}

function PlanCard({ method, plan, best, saving, showIndex, showFees }: {
  method: (typeof METHODS)[number]; plan: DebtPlan; best: boolean; saving: { money: number; months: number | null } | null;
  showIndex: boolean; showFees: boolean;
}) {
  const Icon = method.icon;
  return (
    <div className={cn('rounded-xl border p-4', best ? 'border-positive/60 bg-positive/5' : 'border-line-soft')}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="icon-tile h-8 w-8" style={{ ['--tile' as string]: method.color }}><Icon /></span>
          <div><div className="font-semibold">{method.title}</div><div className="text-xs text-fg-subtle">{method.sub}</div></div>
        </div>
        {best && <span className="shrink-0 whitespace-nowrap rounded-md bg-positive/10 px-1.5 py-0.5 text-xs font-semibold text-positive">הזולה יותר</span>}
      </div>
      <div className="mt-3 text-lg font-bold">
        {plan.months == null ? <span className="text-negative">לא נגמר תוך {MAX_MONTHS / 12} שנה</span> : yearsText(plan.months)}
      </div>
      {plan.months != null && <div className="text-xs text-fg-subtle">החוב האחרון נסגר ב{monthName(monthKeyIn(plan.months))}</div>}
      <dl className="mt-3 space-y-1 text-sm">
        <div className="flex justify-between gap-2"><dt>ריבית</dt><dd><Money value={plan.interest} /></dd></div>
        {showIndex && <div className="flex justify-between gap-2"><dt>הצמדה למדד</dt><dd><Money value={plan.indexation} /></dd></div>}
        {showFees && <div className="flex justify-between gap-2"><dt>עמלות פירעון</dt><dd><Money value={plan.fees} /></dd></div>}
        <div className="flex justify-between gap-2 text-fg-subtle"><dt>סך הכול משלמים</dt><dd><Money value={plan.totalPaid} /></dd></div>
        {saving && (
          <div className="flex justify-between gap-2 border-t border-line-soft pt-1.5 font-medium">
            <dt>חיסכון מול בלי שינוי</dt>
            <dd className={saving.money > 0 ? 'text-positive' : saving.money < 0 ? 'text-negative' : ''}>
              <Money value={saving.money} />{saving.months != null && saving.months > 0 && <span className="text-xs font-normal"> · {monthsText(saving.months)} מוקדם יותר</span>}
            </dd>
          </div>
        )}
      </dl>
      {plan.closing.length > 1 && (
        <ol className="mt-3 list-inside list-decimal space-y-0.5 text-xs text-fg-subtle">
          {plan.closing.map(c => <li key={c.id}>{c.name}{c.month != null && <> · {shortMonth(c.month)}</>}</li>)}
        </ol>
      )}
    </div>
  );
}
