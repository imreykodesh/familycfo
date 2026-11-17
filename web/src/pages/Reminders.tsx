import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, ArrowLeft, Check, Pencil, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { api, type ReminderRepeat, type RemindersReport } from '../api';
import { day } from '../format';
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader, Picker, SectionTitle, Segmented } from '../components/ui';
import { cn } from '@/lib/utils';

const REPEAT: Record<ReminderRepeat, string> = { once: 'פעם אחת', monthly: 'כל חודש', yearly: 'כל שנה' };
const KIND: Record<string, string> = { insurance: 'ביטוח', loan: 'הלוואה', study_fund: 'קרן השתלמות', planned: 'הוצאה מתוכננת' };
// screens a reminder can open when it's clicked (optional)
const SCREENS: [string, string][] = [
  ['', 'בלי'], ['/', 'סקירה'], ['/fixed', 'קבועות החודש'], ['/budgets', 'תקציב'], ['/insurance', 'ביטוחים'], ['/pension', 'פנסיה וגמל'],
  ['/loans', 'הלוואות ומשכנתא'], ['/iou', 'הלוואות בין אנשים'], ['/savings', 'חסכונות'], ['/investments', 'השקעות'], ['/month-close', 'סגירת חודש'],
  ['/maaser', 'מעשרות'], ['/settings', 'הגדרות'],
];
const when = (at: string) => `${day(at.slice(0, 10))} ${at.slice(11, 16)}`;

interface Draft { id?: number; text: string; date: string; time: string; repeat: ReminderRepeat; href: string }

export default function Reminders() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['reminders'], queryFn: () => api.get<RemindersReport>('/reminders') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const call = useMutation({
    mutationFn: ({ method, path, body }: { method: 'post' | 'patch' | 'del'; path: string; body?: unknown }) =>
      (method === 'del' ? api.del<RemindersReport>(path) : api[method]<RemindersReport>(path, body ?? {})),
    onSuccess: res => { qc.setQueryData(['reminders'], res); qc.invalidateQueries({ queryKey: ['alerts'] }); setDraft(null); },
  });

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;
  const active = data.reminders.filter(r => !r.doneAt);
  const stopped = data.reminders.filter(r => r.doneAt);
  const tomorrow = new Date(Date.parse(`${data.now.slice(0, 10)}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const screen = (href: string | null) => SCREENS.find(([p]) => p === href)?.[1] ?? href;

  return (
    <>
      <PageHeader icon={AlarmClock} title="תזכורות"
        subtitle="תזכורות שלכם, ותזכורות שהאפליקציה מוסיפה לבד מתאריכים שכבר יש בה. באפליקציה במחשב הן קופצות כהתראה בשעה שנקבעה."
        actions={<button className="btn btn-primary" onClick={() => setDraft({ text: '', date: tomorrow, time: '09:00', repeat: 'once', href: '' })}><Plus />תזכורת</button>} />

      <div className="card">
        <SectionTitle icon={AlarmClock}>התזכורות שלכם</SectionTitle>
        {active.length === 0 ? <Empty>אין תזכורות. למשל: תשלום לוועד הבית כל חודש, חידוש רישיון רכב כל שנה, או להתקשר לבנק ביום מסוים.</Empty> : (
          <div className="space-y-1.5">
            {active.map(r => (
              <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line-soft px-3 py-2">
                <div className="min-w-0 flex-1 basis-60">
                  <div className="font-medium">{r.text}</div>
                  <div className="text-xs text-fg-subtle">
                    {r.nextAt ? <>הבאה: {when(r.nextAt)}</> : 'אין עוד'} · {REPEAT[r.repeat]}
                    {r.href && <> · <Link className="text-primary hover:underline" to={r.href}>{screen(r.href)}</Link></>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button className="btn-ghost text-xs" title={r.repeat === 'once' ? 'בוצע' : 'להפסיק להזכיר'} onClick={() => call.mutate({ method: 'patch', path: `/reminders/${r.id}`, body: { done: true } })}>
                    <Check className="h-3.5 w-3.5" />{r.repeat === 'once' ? 'בוצע' : 'להפסיק'}
                  </button>
                  <button className="btn-ghost btn-icon" aria-label="עריכה"
                    onClick={() => setDraft({ id: r.id, text: r.text, date: (r.nextAt ?? r.startAt).slice(0, 10), time: (r.nextAt ?? r.startAt).slice(11, 16), repeat: r.repeat, href: r.href ?? '' })}><Pencil /></button>
                </div>
              </div>
            ))}
          </div>
        )}
        {stopped.length > 0 && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-fg-subtle">הסתיימו ({stopped.length})</summary>
            <div className="mt-2 space-y-1">
              {stopped.map(r => (
                <div key={r.id} className="flex items-center justify-between gap-2 text-fg-subtle">
                  <span>{r.text} · {REPEAT[r.repeat]}{r.lastFiredAt && ` · הזכרנו ב-${when(r.lastFiredAt)}`}</span>
                  <span className="flex gap-1">
                    {r.repeat !== 'once' && <button className="btn-ghost text-xs" onClick={() => call.mutate({ method: 'patch', path: `/reminders/${r.id}`, body: { done: false } })}><RotateCcw className="h-3.5 w-3.5" />להחזיר</button>}
                    <button className="btn-ghost btn-icon" aria-label="מחיקה" onClick={() => call.mutate({ method: 'del', path: `/reminders/${r.id}` })}><Trash2 /></button>
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="card mt-4">
        <SectionTitle icon={Sparkles} color="var(--chart-5)">תזכורות אוטומטיות (4 החודשים הקרובים)</SectionTitle>
        <p className="-mt-2 mb-3 text-xs text-fg-subtle">חודש לפני שביטוח מסתיים או מתחדש, שהלוואה מסתיימת ושקרן השתלמות נעשית נזילה, ו-3 ימים לפני הוצאה מתוכננת.</p>
        {data.auto.length === 0 ? <Empty>אין תאריכים קרובים. התאריכים באים ממסכי הביטוחים, ההלוואות, הפנסיה וההוצאות הצפויות.</Empty> : (
          <div className="space-y-1.5">
            {data.auto.map(a => (
              <div key={a.key} className={cn('flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2', a.remindOn <= data.now.slice(0, 10) ? 'border-primary/30 bg-primary/5' : 'border-line-soft')}>
                <div className="min-w-0 flex-1 basis-60">
                  <div className="font-medium"><span className="me-1.5 rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal">{KIND[a.kind]}</span>{a.title}</div>
                  <div className="text-xs text-fg-subtle">{a.remindOn <= data.now.slice(0, 10) ? 'הוזכר' : `נזכיר ב-${day(a.remindOn)}`}</div>
                </div>
                <Link className="btn" to={a.href}>לפתוח<ArrowLeft /></Link>
              </div>
            ))}
          </div>
        )}
      </div>
      {call.error && <div className="mt-3"><ErrorBox error={call.error} /></div>}

      {draft && (
        <Modal title={draft.id ? 'עריכת תזכורת' : 'תזכורת חדשה'} onClose={() => setDraft(null)} footer={<>
          {draft.id && <button className="btn me-auto text-negative" onClick={() => call.mutate({ method: 'del', path: `/reminders/${draft.id}` })}><Trash2 />מחיקה</button>}
          <button className="btn" onClick={() => setDraft(null)}>ביטול</button>
          <button className="btn btn-primary" disabled={!draft.text.trim() || !draft.date || !draft.time || call.isPending}
            onClick={() => {
              const body = { text: draft.text, at: `${draft.date}T${draft.time}`, repeat: draft.repeat, href: draft.href || null };
              call.mutate(draft.id ? { method: 'patch', path: `/reminders/${draft.id}`, body } : { method: 'post', path: '/reminders', body });
            }}>שמור</button>
        </>}>
          <Field label="מה להזכיר"><input className="input" autoFocus value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} placeholder="לשלם לוועד הבית" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="תאריך"><input className="input" type="date" value={draft.date} onChange={e => setDraft({ ...draft, date: e.target.value })} /></Field>
            <Field label="שעה"><input className="input" type="time" value={draft.time} onChange={e => setDraft({ ...draft, time: e.target.value })} /></Field>
          </div>
          <div>
            <span className="label">חזרה</span>
            <Segmented value={draft.repeat} onChange={repeat => setDraft({ ...draft, repeat })}
              options={(Object.keys(REPEAT) as ReminderRepeat[]).map(value => ({ value, label: REPEAT[value] }))} />
          </div>
          <Field label="מסך לפתוח בלחיצה (רשות)">
            <Picker value={draft.href} onChange={v => setDraft({ ...draft, href: v ?? '' })} options={SCREENS.map(([value, label]) => ({ value, label }))} />
          </Field>
        </Modal>
      )}
    </>
  );
}
