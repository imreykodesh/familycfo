import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, Check, Handshake, Link2, Pencil, Plus, Trash2, Undo2, X } from 'lucide-react';
import { api, type Iou, type IouCandidate, type IouReport } from '../api';
import { useLookups } from '../state';
import { day, todayIso } from '../format';
import { Empty, ErrorBox, Field, Loading, Modal, Money, PageHeader, Progress, SectionTitle, Segmented, Stat } from '../components/ui';
import { cn } from '@/lib/utils';

interface Draft { id?: number; direction: Iou['direction']; person: string; amount: number | ''; date: string; dueDate: string; matchPattern: string; notes: string }
const REFRESH = ['iou', 'alerts', 'transactions', 'summary', 'cashflow', 'budgets', 'month-plan'];

export default function IouPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['iou'], queryFn: () => api.get<IouReport>('/iou') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [paying, setPaying] = useState<{ iou: Iou; amount: number | ''; date: string } | null>(null);
  const [showDone, setShowDone] = useState(false);
  const done = (res: IouReport) => { qc.setQueryData(['iou'], res); for (const k of REFRESH.slice(1)) qc.invalidateQueries({ queryKey: [k] }); };
  const call = useMutation({
    mutationFn: ({ method, path, body }: { method: 'post' | 'patch' | 'put' | 'del'; path: string; body?: unknown }) =>
      (method === 'del' ? api.del<IouReport>(path) : api[method]<IouReport>(path, body ?? {})),
    onSuccess: res => { done(res); setDraft(null); setPaying(null); },
  });

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;
  const open = data.items.filter(i => !i.doneAt);
  const closed = data.items.filter(i => i.doneAt);
  const newDraft = (direction: Iou['direction']): Draft => ({ direction, person: '', amount: '', date: todayIso(), dueDate: '', matchPattern: '', notes: '' });

  return (
    <>
      <PageHeader icon={Handshake} title="הלוואות בין אנשים"
        subtitle="מי חייב לכם ולמי אתם חייבים. החזר שמגיע בביט, בפייבוקס או בהעברה מאותו אדם מוצע לבד."
        actions={<>
          <button className="btn" onClick={() => setDraft(newDraft('i_owe'))}><Plus />לוויתי</button>
          <button className="btn btn-primary" onClick={() => setDraft(newDraft('owed_to_me'))}><Plus />הלוויתי</button>
        </>} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:gap-4">
        <Stat index={0} icon={ArrowDownLeft} color="var(--positive)" label="חייבים לכם" value={data.totals.owedToMe}
          hint={`${open.filter(i => i.direction === 'owed_to_me').length} הלוואות פתוחות`} />
        <Stat index={1} icon={ArrowUpRight} color="var(--negative)" label="אתם חייבים" value={data.totals.iOwe}
          hint={`${open.filter(i => i.direction === 'i_owe').length} הלוואות פתוחות`} />
      </div>

      <div className="mt-4 space-y-3">
        {open.length === 0 && <div className="card"><Empty>אין הלוואות פתוחות. „הלוויתי" כשמישהו חייב לכם, „לוויתי" כשאתם חייבים.</Empty></div>}
        {open.map(i => <IouCard key={i.id} i={i} busy={call.isPending}
          onEdit={() => setDraft({ id: i.id, direction: i.direction, person: i.person, amount: i.amount, date: i.date, dueDate: i.dueDate ?? '', matchPattern: i.matchPattern ?? '', notes: i.notes ?? '' })}
          onPay={() => setPaying({ iou: i, amount: i.remaining, date: todayIso() })}
          onCall={(method, path, body) => call.mutate({ method, path, body })} />)}
      </div>

      {closed.length > 0 && (
        <div className="card mt-4">
          <SectionTitle icon={Check} color="var(--positive)" action={<button className="btn-ghost text-xs" onClick={() => setShowDone(!showDone)}>{showDone ? 'הסתר' : 'הצג'}</button>}>
            נסגרו ({closed.length})
          </SectionTitle>
          {showDone && <div className="space-y-1.5">{closed.map(i => (
            <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line-soft px-3 py-2 text-sm">
              <span><b>{i.person}</b> · {i.direction === 'owed_to_me' ? 'הלוויתם' : 'לוויתם'} <Money value={i.amount} /> · הוחזרו <Money value={i.paid} /> · נסגר {day(i.doneAt)}</span>
              <span className="flex gap-1.5">
                <button className="btn-ghost text-xs" onClick={() => call.mutate({ method: 'patch', path: `/iou/${i.id}`, body: { done: false } })}><Undo2 className="h-3.5 w-3.5" />לפתוח מחדש</button>
                <button className="btn-ghost btn-icon" aria-label="מחיקה" onClick={() => call.mutate({ method: 'del', path: `/iou/${i.id}` })}><Trash2 /></button>
              </span>
            </div>
          ))}</div>}
        </div>
      )}

      <p className="mt-4 text-xs leading-relaxed text-fg-subtle">
        תנועה שמקושרת להלוואה (הכסף שיצא או החזר שנכנס) מסומנת כהעברה: הלוואה היא לא הוצאה, והחזר הוא לא הכנסה. ביטול הקישור מחזיר אותה למה שהייתה.
      </p>

      {call.error && <div className="mt-3"><ErrorBox error={call.error} /></div>}

      {draft && (
        <Modal title={draft.id ? 'עריכה' : draft.direction === 'owed_to_me' ? 'הלוויתי כסף' : 'לוויתי כסף'} onClose={() => setDraft(null)} footer={<>
          {draft.id && <button className="btn me-auto text-negative" onClick={() => call.mutate({ method: 'del', path: `/iou/${draft.id}` })}><Trash2 />מחיקה</button>}
          <button className="btn" onClick={() => setDraft(null)}>ביטול</button>
          <button className="btn btn-primary" disabled={!draft.person.trim() || !draft.amount || call.isPending}
            onClick={() => { const { id, ...b } = draft; call.mutate(id ? { method: 'patch', path: `/iou/${id}`, body: b } : { method: 'post', path: '/iou', body: b }); }}>שמור</button>
        </>}>
          {!draft.id && <Segmented value={draft.direction} onChange={direction => setDraft({ ...draft, direction })}
            options={[{ value: 'owed_to_me' as const, label: 'חייבים לי' }, { value: 'i_owe' as const, label: 'אני חייב' }]} />}
          <div className="grid grid-cols-2 gap-3">
            <Field label="מי"><input className="input" value={draft.person} autoFocus onChange={e => setDraft({ ...draft, person: e.target.value })} placeholder="דנה כהן" /></Field>
            <Field label="סכום (₪)"><input className="input num" type="number" min={0} value={draft.amount} onChange={e => setDraft({ ...draft, amount: e.target.value === '' ? '' : Number(e.target.value) })} /></Field>
            <Field label="מתי"><input className="input" type="date" value={draft.date} onChange={e => setDraft({ ...draft, date: e.target.value })} /></Field>
            <Field label="עד מתי להחזיר (רשות)"><input className="input" type="date" value={draft.dueDate} onChange={e => setDraft({ ...draft, dueDate: e.target.value })} /></Field>
          </div>
          <Field label="איך השם מופיע בביט / בהעברה (רשות, ברירת מחדל: השם)">
            <input className="input" value={draft.matchPattern} onChange={e => setDraft({ ...draft, matchPattern: e.target.value })} placeholder={draft.person || 'דנה כהן'} />
          </Field>
          <Field label="הערה"><input className="input" value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} /></Field>
        </Modal>
      )}

      {paying && (
        <Modal title={`החזר — ${paying.iou.person}`} onClose={() => setPaying(null)} footer={<>
          <button className="btn" onClick={() => setPaying(null)}>ביטול</button>
          <button className="btn btn-primary" disabled={!paying.amount || call.isPending}
            onClick={() => call.mutate({ method: 'post', path: `/iou/${paying.iou.id}/payments`, body: { amount: paying.amount, date: paying.date } })}>שמור</button>
        </>}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="סכום (₪)"><input className="input num" type="number" min={0} value={paying.amount} autoFocus onChange={e => setPaying({ ...paying, amount: e.target.value === '' ? '' : Number(e.target.value) })} /></Field>
            <Field label="תאריך"><input className="input" type="date" value={paying.date} onChange={e => setPaying({ ...paying, date: e.target.value })} /></Field>
          </div>
          <p className="text-xs text-fg-subtle">החזר במזומן או משהו שלא מופיע בחשבונות. החזר שכן מופיע (ביט, העברה) יוצע לבד בכרטיס.</p>
        </Modal>
      )}
    </>
  );
}

function IouCard({ i, busy, onEdit, onPay, onCall }: {
  i: Iou; busy: boolean; onEdit: () => void; onPay: () => void;
  onCall: (method: 'post' | 'patch' | 'put' | 'del', path: string, body?: unknown) => void;
}) {
  const { accountName } = useLookups();
  const owed = i.direction === 'owed_to_me';
  const row = (c: IouCandidate) => <><b>{c.description}</b> · <Money value={Math.abs(c.amount)} /> · {day(c.date)} <span className="text-fg-subtle">· {accountName(c.accountId)}</span></>;
  return (
    <div className={cn('card', i.overdue && 'border-amber-300/70 dark:border-amber-800/60')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn('rounded-md px-1.5 py-0.5 text-xs font-semibold', owed ? 'bg-positive/10 text-positive' : 'bg-negative/10 text-negative')}>{owed ? 'חייב/ת לכם' : 'אתם חייבים'}</span>
            <span className="text-base font-semibold">{i.person}</span>
          </div>
          <div className="mt-1 text-sm text-fg-subtle">
            <Money value={i.amount} /> מ-{day(i.date)}{i.dueDate && <> · {i.overdue ? <span className="font-medium text-amber-600 dark:text-amber-400">היה אמור לחזור עד {day(i.dueDate)}</span> : <>להחזיר עד {day(i.dueDate)}</>}</>}
            {i.notes && <> · {i.notes}</>}
          </div>
        </div>
        <div className="text-end">
          <div className="label">נשאר</div>
          <Money value={i.remaining} className="text-lg font-bold" />
        </div>
      </div>
      <Progress className="mt-3" value={i.paid} max={i.amount} />
      {i.payments.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-fg-subtle">
          {i.payments.map(p => (
            <li key={p.id} className="flex items-center gap-2">
              <span>החזר <Money value={p.amount} /> ב-{day(p.date)}{p.description && ` · ${p.description}`}</span>
              <button className="hover:text-negative" aria-label="ביטול ההחזר" onClick={() => onCall('del', `/iou/${i.id}/payments/${p.id}`)}><X className="h-3 w-3" /></button>
            </li>
          ))}
        </ul>
      )}

      {i.paymentCandidates.map(c => (
        <div key={c.id} className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span>נראה כמו החזר: {row(c)}</span>
          <span className="flex gap-1.5">
            <button className="btn" disabled={busy} onClick={() => onCall('post', `/iou/${i.id}/payments`, { txnId: c.id })}><Check />כן, זה החזר</button>
            <button className="btn-ghost text-xs" disabled={busy} onClick={() => onCall('post', `/iou/${i.id}/reject`, { txnId: c.id })}>לא</button>
          </span>
        </div>
      ))}
      {i.sourceCandidates.map(c => (
        <div key={c.id} className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line-soft bg-muted/40 px-3 py-2 text-sm">
          <span>{owed ? 'זו התנועה שבה הכסף יצא?' : 'זו התנועה שבה הכסף נכנס?'} {row(c)}</span>
          <span className="flex gap-1.5">
            <button className="btn" disabled={busy} onClick={() => onCall('put', `/iou/${i.id}/source`, { txnId: c.id })}><Link2 />כן</button>
            <button className="btn-ghost text-xs" disabled={busy} onClick={() => onCall('post', `/iou/${i.id}/reject`, { txnId: c.id })}>לא</button>
          </span>
        </div>
      ))}
      {i.source && (
        <div className="mt-2 flex items-center gap-2 text-xs text-fg-subtle">
          <Link2 className="h-3.5 w-3.5" />{i.source.description} · <Money value={Math.abs(i.source.amount)} /> · {day(i.source.date)}
          <button className="hover:text-negative" aria-label="ביטול הקישור" onClick={() => onCall('put', `/iou/${i.id}/source`, { txnId: null })}><X className="h-3 w-3" /></button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line-soft pt-3">
        <button className="btn" onClick={onPay}><Plus />החזר ידני</button>
        <button className="btn-ghost" onClick={() => onCall('patch', `/iou/${i.id}`, { done: true })}>{owed ? 'סגור (הוחזר / ויתרתי)' : 'סגור'}</button>
        <button className="btn-ghost btn-icon ms-auto" aria-label="עריכה" onClick={onEdit}><Pencil /></button>
      </div>
    </div>
  );
}
