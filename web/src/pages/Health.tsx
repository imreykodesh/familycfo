import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, CircleAlert, EyeOff, HeartPulse, Lightbulb, RotateCcw } from 'lucide-react';
import { api, type HealthAction, type HealthItem, type HealthReport } from '../api';
import { Empty, ErrorBox, Loading, PageHeader, SectionTitle, Stat } from '../components/ui';
import { cn } from '@/lib/utils';

// what changes when a button here runs (links, rules, planned items) — refresh the screens that show it
const REFRESH = ['health', 'transactions', 'summary', 'budgets', 'cashflow', 'month-plan', 'planned', 'rules', 'alerts', 'month-close'];

export default function Health() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['health'], queryFn: () => api.get<HealthReport>('/health') });
  const [showOk, setShowOk] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const refresh = () => { for (const k of REFRESH) qc.invalidateQueries({ queryKey: [k] }); };

  const act = useMutation({
    mutationFn: ({ a }: { item: HealthItem; a: HealthAction }) =>
      (a.method === 'POST' ? api.post<{ applied?: number }>(a.path, a.body) : api.patch<{ applied?: number }>(a.path, a.body)),
    onSuccess: (res, { item }) => {
      if (item.kind === 'rule') setDone(res?.applied ? `הכלל נוצר וסיווג ${res.applied} תנועות.` : 'הכלל נוצר. מעכשיו תנועות כאלה יסווגו לבד.');
      refresh();
    },
  });
  const ignore = useMutation({
    mutationFn: (b: { id: string; ignore: boolean }) => api.put<HealthReport>('/health/ignore', b),
    onSuccess: res => { qc.setQueryData(['health'], res); },
  });

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;

  const problems = data.items.filter(i => i.status === 'problem' && !i.ignored);
  const suggestions = data.items.filter(i => i.status === 'suggestion' && !i.ignored);
  const ignored = data.items.filter(i => i.ignored);
  const ok = data.items.filter(i => i.status === 'ok');
  const row = (i: HealthItem) => (
    <Row key={i.id} item={i} busy={act.isPending || ignore.isPending}
      onAction={a => act.mutate({ item: i, a })} onIgnore={v => ignore.mutate({ id: i.id, ignore: v })} />
  );

  return (
    <>
      <PageHeader icon={HeartPulse} title="בדיקת תקינות"
        subtitle="כל מה שיכול לגרום למספרים לצאת לא נכונים, במקום אחד: משיכות שנכשלו, יתרות ישנות, כפילויות, הוצאות בלי קטגוריה, חודשים חסרים ועוד." />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 md:gap-4">
        <Stat index={0} icon={CircleAlert} label="בעיות" value={data.problems} format={n => String(Math.round(n))}
          tone={data.problems ? 'bad' : 'good'} hint={data.problems ? 'המספר האדום בתפריט' : 'אין בעיות פתוחות'} />
        <Stat index={1} icon={Lightbulb} color="var(--chart-3)" label="הצעות" value={data.suggestions} format={n => String(Math.round(n))}
          hint="דברים שכדאי להחליט עליהם, לא תקלות" />
        <Stat index={2} icon={Check} label="נבדק ותקין" value={ok.length} format={n => String(Math.round(n))} tone="good"
          hint={<button className="text-primary hover:underline" onClick={() => setShowOk(!showOk)}>{showOk ? 'הסתר' : 'מה נבדק'}</button>} />
      </div>

      {done && (
        <div className="mt-4 flex items-center justify-between gap-2 rounded-lg border border-positive/40 bg-positive/5 px-3 py-2 text-sm">
          <span>{done}</span><button className="btn-ghost text-xs" onClick={() => setDone(null)}>סגור</button>
        </div>
      )}
      {act.error && <div className="mt-4"><ErrorBox error={act.error} /></div>}

      <div className="card mt-4">
        <SectionTitle icon={CircleAlert} color="var(--negative)">בעיות</SectionTitle>
        {problems.length ? <div className="space-y-2">{problems.map(row)}</div> : <Empty>אין בעיות. הנתונים מעודכנים ושלמים.</Empty>}
      </div>

      {suggestions.length > 0 && (
        <div className="card mt-4">
          <SectionTitle icon={Lightbulb} color="var(--chart-3)">הצעות</SectionTitle>
          <div className="space-y-2">{suggestions.map(row)}</div>
        </div>
      )}

      {ignored.length > 0 && (
        <div className="card mt-4">
          <SectionTitle icon={EyeOff} color="var(--muted-foreground)">הוסתרו</SectionTitle>
          <p className="-mt-2 mb-3 text-xs text-fg-subtle">שורה מוסתרת חוזרת לבד כשהמצב שלה משתנה (למשל כפילות חדשה).</p>
          <div className="space-y-2">{ignored.map(row)}</div>
        </div>
      )}

      {showOk && (
        <div className="card mt-4">
          <SectionTitle icon={Check} color="var(--positive)">נבדק ותקין</SectionTitle>
          <ul className="space-y-1 text-sm">
            {ok.map(i => <li key={i.id} className="flex items-center gap-2"><Check className="h-4 w-4 shrink-0 text-positive" />{i.title}</li>)}
          </ul>
        </div>
      )}
    </>
  );
}

function Row({ item, busy, onAction, onIgnore }: {
  item: HealthItem; busy: boolean; onAction: (a: HealthAction) => void; onIgnore: (ignore: boolean) => void;
}) {
  const tone = item.ignored ? 'border-line-soft opacity-70' : item.status === 'problem' ? 'border-negative/30 bg-negative/[0.03]' : 'border-line-soft';
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-lg border px-3 py-2.5', tone)}>
      <div className="min-w-0 flex-1 basis-72">
        <div className="font-medium">{item.title}</div>
        {item.detail && <div className="mt-0.5 text-sm leading-relaxed text-fg-subtle">{item.detail}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!item.ignored && item.actions?.map(a => (
          <button key={a.label} className="btn" disabled={busy} onClick={() => onAction(a)}>{a.label}</button>
        ))}
        {!item.ignored && item.href && (
          <Link className="btn" to={item.href}>{item.hrefLabel ?? 'לתיקון'}<ArrowLeft /></Link>
        )}
        {item.ignored
          ? <button className="btn-ghost text-sm" disabled={busy} onClick={() => onIgnore(false)}><RotateCcw className="h-4 w-4" />להחזיר</button>
          : <button className="btn-ghost text-sm" disabled={busy} onClick={() => onIgnore(true)} title="להסתיר עד שהמצב משתנה">התעלם</button>}
      </div>
    </div>
  );
}
