import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck2, Check, CircleAlert, CircleHelp, ClipboardCheck, Landmark, Lightbulb, Printer, TrendingDown, TrendingUp } from 'lucide-react';
import { api, qs, type MonthCheck, type MonthCloseResponse, type MonthReport } from '../api';
import { day, monthName } from '../format';
import { ErrorBox, Loading, Money, PageHeader, Picker, SectionTitle, Stat } from '../components/ui';

const ICON = { ok: Check, warn: CircleAlert, ask: CircleHelp };
const TONE = { ok: 'text-positive bg-positive/10', warn: 'text-amber-600 bg-amber-500/10', ask: 'text-primary bg-primary/10' };
const FIXED_ANSWERS: { value: 'ended' | 'later' | 'other'; label: string }[] = [
  { value: 'ended', label: 'הסתיים' }, { value: 'later', label: 'עוד יגיע' }, { value: 'other', label: 'שולם אחרת' },
];

export default function MonthClose() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const cycle = params.get('cycle') ?? undefined;
  const [open, setOpen] = useState(true);
  const close = useQuery({ queryKey: ['month-close', cycle], queryFn: () => api.get<MonthCloseResponse>(`/month-close${qs({ cycle })}`) });
  const key = close.data?.state.cycle.key;
  const report = useQuery({ queryKey: ['month-report', key], enabled: !!key, queryFn: () => api.get<MonthReport>(`/month-report${qs({ cycle: key })}`) });

  const refresh = () => { for (const k of ['month-close', 'month-report', 'summary', 'scheduled', 'month-plan']) qc.invalidateQueries({ queryKey: [k] }); };
  const answer = useMutation({ mutationFn: (b: { checkId: string; answer: string | null }) => api.put(`/month-close/${key}/checks`, b), onSuccess: refresh });
  const doClose = useMutation({ mutationFn: () => api.post(`/month-close/${key}`, {}), onSuccess: refresh });
  const reopen = useMutation({ mutationFn: () => api.del(`/month-close/${key}`), onSuccess: refresh });

  if (close.isLoading) return <Loading />;
  if (close.error || !close.data) return <ErrorBox error={close.error} />;
  const { state, history } = close.data;
  const r = report.data;
  const name = monthName(state.cycle.key);

  return (
    <>
      <PageHeader icon={ClipboardCheck} title={`סגירת חודש ודוח — ${name}`}
        subtitle={`${day(state.cycle.start)} – ${day(state.cycle.end)}. מה צריך לבדוק כדי שהמספרים של החודש יהיו נכונים, ומה קרה בו.`}
        actions={<div className="flex items-center gap-2 print:hidden">
          <Picker className="input w-auto min-w-40" aria-label="חודש" value={state.cycle.key}
            onChange={v => v && setParams({ cycle: v })}
            options={history.map(h => ({ value: h.key, label: `${monthName(h.key)}${h.closed ? ' ✓' : ''}` }))} />
          <button className="btn" onClick={() => window.print()}><Printer />הדפסה</button>
        </div>} />

      {/* the closing card: collapsed once closed */}
      {state.closed && !state.closed.changed ? (
        <div className="card flex flex-wrap items-center justify-between gap-3 print:hidden">
          <span className="flex items-center gap-2 font-semibold text-positive"><CalendarCheck2 className="h-5 w-5" />{name} סגור <span className="text-xs font-normal text-fg-subtle">נסגר ב-{day(state.closed.at)}</span></span>
          <button className="btn-ghost" onClick={() => reopen.mutate()}>פתח מחדש</button>
        </div>
      ) : (
        <div className="card print:hidden">
          <button type="button" className="flex w-full items-center justify-between gap-3 text-start" onClick={() => setOpen(!open)} aria-expanded={open}>
            <SectionTitle icon={ClipboardCheck} color="var(--chart-2)">
              <span>סגירת {name}</span>
              <span className="ms-2 text-xs font-normal text-fg-subtle">{state.todo ? (state.todo === 1 ? 'דבר אחד לבדוק' : `${state.todo} דברים לבדוק`) : 'הכול נבדק'}</span>
            </SectionTitle>
          </button>
          {state.closed?.changed && <p className="mb-3 text-sm text-amber-600">החודש נסגר ב-{day(state.closed.at)}, ומאז השתנו בו תנועות. כדאי לעבור שוב ולסגור מחדש.</p>}
          {open && (
            <div className="space-y-2">
              {state.checks.map(c => <CheckRow key={c.id} c={c} onAnswer={a => answer.mutate({ checkId: c.id, answer: a })} />)}
              <div className="flex flex-wrap items-center gap-3 border-t border-line-soft pt-3">
                <button className="btn btn-primary" disabled={doClose.isPending} onClick={() => doClose.mutate()}><Check />{state.closed ? 'סגור שוב' : `סגור את ${name}`}</button>
                <span className="text-xs text-fg-subtle">הסגירה היא סימון בלבד: שומרת את המספרים של החודש, ואפשר להמשיך לערוך תנועות גם אחריה.</span>
              </div>
            </div>
          )}
        </div>
      )}

      {r && <Report r={r} />}
    </>
  );
}

function CheckRow({ c, onAnswer }: { c: MonthCheck; onAnswer: (a: string | null) => void }) {
  const Icon = ICON[c.status];
  return (
    <div className="flex gap-3 rounded-lg border border-line-soft bg-muted/40 px-3 py-2.5">
      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${TONE[c.status]}`}><Icon className="h-3.5 w-3.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{c.title}</div>
        {c.detail && <div className="text-xs leading-relaxed text-fg-subtle">{c.detail}</div>}
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {c.kind === 'fixed' && FIXED_ANSWERS.map(a => (
            <button key={a.value} className={c.answer === a.value ? 'btn btn-primary h-7 px-2.5 text-xs' : 'btn h-7 px-2.5 text-xs'}
              onClick={() => onAnswer(c.answer === a.value ? null : a.value)}>{a.label}</button>
          ))}
          {c.kind !== 'fixed' && c.status !== 'ok' && c.href && <Link className="btn h-7 px-2.5 text-xs" to={c.href}>{c.href === '/' ? 'לעדכון נתונים' : 'להצגה'}</Link>}
          {c.kind !== 'fixed' && c.status === 'warn' && <button className="btn-ghost h-7 px-2.5 text-xs" onClick={() => onAnswer('ok')}>✓ זה בסדר</button>}
          {c.approved && <button className="btn-ghost h-7 px-2.5 text-xs" onClick={() => onAnswer(null)}>בטל אישור</button>}
        </div>
      </div>
    </div>
  );
}

function Report({ r }: { r: MonthReport }) {
  const vsAvg = r.average.months ? r.net - r.average.net : null;
  return (
    <div className="mt-4 space-y-4">
      <div className={`card ${r.net >= 0 ? 'border-emerald-200/70 dark:border-emerald-900/50' : 'border-rose-200/70 dark:border-rose-900/50'}`}>
        <div className="text-sm text-fg-subtle">התשובה של {monthName(r.cycle.key)}</div>
        <div className={`mt-1 text-2xl font-bold ${r.net >= 0 ? 'text-positive' : 'text-negative'}`}>
          {r.net >= 0 ? 'נשארו ' : 'חסרו '}<Money value={Math.abs(r.net)} />
        </div>
        <p className="mt-1 text-sm text-fg-subtle">
          הכנסות <Money value={r.income} /> פחות הוצאות <Money value={r.spend} />.
          {vsAvg != null && <> {vsAvg >= 0 ? 'טוב' : 'פחות טוב'} ב-<Money value={Math.abs(vsAvg)} /> מהממוצע של {r.average.months} החודשים שלפניו.</>}
          {r.savingsDeposits > 0 && <> בנוסף הופקדו לחיסכון <Money value={r.savingsDeposits} />.</>}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat index={0} icon={TrendingUp} tone="good" label="הכנסות" value={r.income} hint={r.average.months ? <>ממוצע <Money value={r.average.income} /></> : undefined} />
        <Stat index={1} icon={TrendingDown} label="הוצאות" value={r.spend} hint={r.average.months ? <>ממוצע <Money value={r.average.spend} /></> : undefined} />
        <Stat index={2} icon={CalendarCheck2} color="var(--chart-1)" label="מזה קבועות" value={r.fixed} hint={<>משתנות <Money value={r.dynamic} /></>} />
        <Stat index={3} icon={Landmark} color="var(--chart-5)" label="יתרת חובות" value={r.debts.total} hint={r.debts.monthly ? <>החזר חודשי <Money value={r.debts.monthly} /></> : 'אין הלוואות רשומות'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card min-w-0">
          <SectionTitle icon={TrendingDown} color="var(--chart-6)">לאן הלך הכסף — מול חודש רגיל</SectionTitle>
          <table className="table">
            <thead><tr><th>קטגוריה</th><th className="text-end">החודש</th><th className="text-end">ממוצע</th><th className="text-end">הפרש</th></tr></thead>
            <tbody>
              {r.categories.map(c => (
                <tr key={String(c.categoryId)}>
                  <td>{c.categoryId != null ? <Link className="hover:underline" to={`/transactions?cycle=${r.cycle.key}&category=${c.categoryId}`}>{c.name}</Link> : c.name}</td>
                  <td className="text-end"><Money value={c.spend} /></td>
                  <td className="text-end text-fg-subtle"><Money value={c.average} /></td>
                  <td className={`text-end ${c.delta > c.average * 0.15 && c.delta > 200 ? 'font-semibold text-negative' : 'text-fg-subtle'}`}>{c.delta > 0 ? '+' : c.delta < 0 ? '−' : ''}<Money value={Math.abs(c.delta)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-4">
          <div className="card">
            <SectionTitle icon={CircleAlert} color="var(--negative)">חריגות מתקציב</SectionTitle>
            {r.overBudget.length === 0 ? <div className="text-sm text-fg-subtle">אין חריגות 🎉</div> : r.overBudget.map(b => (
              <div key={b.categoryId} className="flex justify-between gap-3 py-1 text-sm">
                <span>{b.name}</span><span><Money value={b.spent} /> מתוך <Money value={b.budget} /> <b className="text-negative">(+<Money value={b.spent - b.budget} />)</b></span>
              </div>
            ))}
          </div>
          {r.ended.length > 0 && (
            <div className="card">
              <SectionTitle icon={Check} color="var(--positive)">חיובים שהסתיימו</SectionTitle>
              {r.ended.map(e => <div key={e.name} className="flex justify-between py-1 text-sm"><span>{e.name}</span><Money value={e.amount} /></div>)}
              <p className="mt-2 text-sm text-positive">מתפנים <Money value={r.freedMonthly} /> בחודש מעכשיו.</p>
            </div>
          )}
          <div className="card">
            <SectionTitle icon={Lightbulb} color="var(--chart-3)" action={<Link className="text-xs text-primary print:hidden" to="/insights">כל ההמלצות</Link>}>מה אפשר לשפר</SectionTitle>
            {r.recommendations.length === 0 ? <div className="text-sm text-fg-subtle">אין המלצות פתוחות</div> : r.recommendations.map(x => (
              <div key={x.title} className="py-1.5 text-sm">
                <div className="font-medium">{x.title}{x.monthlySaving > 0 && <span className="ms-1 text-xs font-normal text-positive">חיסכון של כ-<Money value={x.monthlySaving} /> בחודש</span>}</div>
                <div className="text-xs leading-relaxed text-fg-subtle">{x.detail}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
