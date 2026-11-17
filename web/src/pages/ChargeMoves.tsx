import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, Check, CircleAlert, Clock, Plus, Shuffle, Trash2 } from 'lucide-react';
import { api, type ChargeMove, type MoveCandidate } from '../api';
import { useMeta } from '../state';
import { day } from '../format';
import { Empty, ErrorBox, Field, Loading, Money, PageHeader, Picker, SectionTitle } from '../components/ui';
import { cn } from '@/lib/utils';

const CANCEL = '__cancel__';
const KIND: Record<string, string> = { subscription: 'מנוי', bill: 'חשבון', loan: 'הלוואה' };

/** What each status means, for a move and for a cancellation. */
function statusText(m: ChargeMove): { text: string; tone: string; icon: typeof Check } {
  const cancel = m.toAccountId == null;
  switch (m.status) {
    case 'todo': return { text: cancel ? 'עוד לא בוטל' : 'עוד לא הועבר', tone: 'text-fg-subtle', icon: Clock };
    case 'moved': return cancel
      ? { text: `בוטל ב-${day(m.markedAt)}. בודקים שלא יחויב ביום החיוב הבא`, tone: 'text-primary', icon: Clock }
      : { text: `הועבר ב-${day(m.markedAt)}. מחכים לחיוב הראשון ב${m.toName}`, tone: 'text-primary', icon: Clock };
    case 'verified': return cancel
      ? { text: `✓ לא חויב מאז הביטול (נבדק ${day(m.verifiedAt)})`, tone: 'text-positive', icon: Check }
      : { text: `✓ הגיע לכרטיס החדש: ${day(m.evidence?.date)}`, tone: 'text-positive', icon: Check };
    case 'failed': return cancel
      ? { text: `⚠ חויב שוב אחרי הביטול: ${day(m.evidence?.date)}`, tone: 'text-negative', icon: CircleAlert }
      : { text: `⚠ עדיין יורד מ${m.fromName}: ${day(m.evidence?.date)}`, tone: 'text-negative', icon: CircleAlert };
  }
}

export default function ChargeMoves() {
  const qc = useQueryClient();
  const { data: meta } = useMeta();
  const { data, isLoading, error } = useQuery({ queryKey: ['charge-moves'], queryFn: () => api.get<ChargeMove[]>('/charge-moves') });
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const candidates = useQuery({
    queryKey: ['charge-moves', 'candidates', from], enabled: !!from,
    queryFn: () => api.get<MoveCandidate[]>(`/charge-moves/candidates?from=${encodeURIComponent(from!)}`),
  });

  const refresh = () => { for (const k of ['charge-moves', 'alerts']) qc.invalidateQueries({ queryKey: [k] }); };
  const add = useMutation({
    mutationFn: () => api.post('/charge-moves', { fromAccountId: from, toAccountId: to === CANCEL ? null : to, seriesIds: [...picked] }),
    onSuccess: () => { refresh(); setPicked(new Set()); setFrom(null); setTo(null); },
  });
  const mark = useMutation({ mutationFn: (b: { id: number; status: 'moved' | 'todo' }) => api.patch(`/charge-moves/${b.id}`, { status: b.status }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/charge-moves/${id}`), onSuccess: refresh });

  const accounts = (meta?.accounts ?? []).filter(a => a.active && (a.kind === 'bank' || a.kind === 'card'));
  const options = accounts.map(a => ({ value: a.id, label: `${a.kind === 'card' ? '💳' : '🏦'} ${a.displayName ?? a.id}` }));
  // one list per "from → to"
  const groups = useMemo(() => {
    const g = new Map<string, ChargeMove[]>();
    for (const m of data ?? []) { const k = `${m.fromAccountId}|${m.toAccountId ?? ''}`; g.set(k, [...(g.get(k) ?? []), m]); }
    return [...g.values()];
  }, [data]);

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;
  const available = (candidates.data ?? []).filter(c => !c.listed);

  return (
    <>
      <PageHeader icon={Shuffle} title="מעבר כרטיס וביטול חיובים"
        subtitle="עוברים לכרטיס או לבנק אחר? מקבלים רשימה של כל החיובים הקבועים שצריך להעביר. ביטלתם מנוי? האפליקציה בודקת אחרי כל עדכון שהחיוב באמת נפסק." />

      <div className="card">
        <SectionTitle icon={Plus} color="var(--chart-5)">רשימה חדשה</SectionTitle>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="מאיזה חשבון"><Picker value={from} placeholder="בחרו כרטיס או חשבון" options={options}
            onChange={v => { setFrom(v); setPicked(new Set()); if (v === to) setTo(null); }} /></Field>
          <Field label="לאן"><Picker value={to} placeholder="כרטיס חדש, או ביטול"
            options={[{ value: CANCEL, label: '🚫 לבטל את החיובים' }, ...options.filter(o => o.value !== from)]} onChange={setTo} /></Field>
        </div>
        {from && (
          <div className="mt-4">
            {candidates.isLoading ? <Loading /> : available.length === 0 ? (
              <Empty>{candidates.data?.length ? 'כל החיובים הקבועים של החשבון הזה כבר ברשימה.' : 'לא זוהו חיובים קבועים בחשבון הזה (צריך לפחות 3 חודשים של חיוב).'}</Empty>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between gap-2 text-sm">
                  <span className="text-fg-subtle">החיובים הקבועים שזוהו. סמנו מה להכניס לרשימה:</span>
                  <button className="btn-ghost text-xs" onClick={() => setPicked(picked.size === available.length ? new Set() : new Set(available.map(c => c.seriesId)))}>
                    {picked.size === available.length ? 'נקה' : 'סמן הכול'}
                  </button>
                </div>
                <div className="space-y-1.5">
                  {available.map(c => (
                    <label key={c.seriesId} className="flex cursor-pointer items-center gap-3 rounded-lg border border-line-soft px-3 py-2 hover:bg-muted/40">
                      <input type="checkbox" className="accent-primary" checked={picked.has(c.seriesId)}
                        onChange={() => { const n = new Set(picked); n.has(c.seriesId) ? n.delete(c.seriesId) : n.add(c.seriesId); setPicked(n); }} />
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{c.description}</span>
                        <span className="ms-2 text-xs text-fg-subtle">{KIND[c.kind] ?? c.kind}{c.categoryName && ` · ${c.categoryName}`}{c.dayOfMonth && ` · בסביבות ה-${c.dayOfMonth} בחודש`}</span>
                      </span>
                      <Money value={c.amount} />
                    </label>
                  ))}
                </div>
                <button className="btn btn-primary mt-3" disabled={!picked.size || !to || add.isPending} onClick={() => add.mutate()}>
                  {to === CANCEL ? <Ban /> : <ArrowLeft />}
                  {!to ? 'בחרו לאן' : to === CANCEL ? `לרשימת הביטולים (${picked.size})` : `לרשימת ההעברה (${picked.size})`}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {groups.length === 0 ? (
        <div className="card mt-4"><Empty>עוד אין רשימות. אפשר גם לסמן „ביטלתי" ליד מנוי במסך „תובנות והתראות".</Empty></div>
      ) : groups.map(list => {
        const first = list[0];
        const cancel = first.toAccountId == null;
        const done = list.filter(m => m.status === 'verified').length;
        return (
          <div key={`${first.fromAccountId}|${first.toAccountId}`} className="card mt-4">
            <SectionTitle icon={cancel ? Ban : Shuffle} color={cancel ? 'var(--negative)' : 'var(--chart-1)'}>
              <span>{cancel ? `ביטול חיובים ב${first.fromName}` : `מעבר מ${first.fromName} ל${first.toName}`}
                <span className="ms-2 text-xs font-normal text-fg-subtle">{done} מתוך {list.length} אומתו</span></span>
            </SectionTitle>
            <div className="space-y-1.5">
              {list.map(m => {
                const s = statusText(m);
                return (
                  <div key={m.id} className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2',
                    m.status === 'failed' ? 'border-negative/30 bg-negative/[0.03]' : 'border-line-soft')}>
                    <div className="min-w-0 flex-1 basis-60">
                      <div className="font-medium">{m.description} <span className="text-xs font-normal text-fg-subtle">· <Money value={m.amount} />{m.dayOfMonth && ` · ב-${m.dayOfMonth} בחודש`}</span></div>
                      <div className={cn('text-xs', s.tone)}>{s.text}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {m.status === 'todo' && <button className="btn" onClick={() => mark.mutate({ id: m.id, status: 'moved' })}><Check />{cancel ? 'בוטל' : 'הועבר'}</button>}
                      {m.status === 'moved' && <button className="btn-ghost text-xs" onClick={() => mark.mutate({ id: m.id, status: 'todo' })}>עוד לא</button>}
                      {m.status === 'failed' && <button className="btn" onClick={() => mark.mutate({ id: m.id, status: 'moved' })} title="טיפלתם שוב: הבדיקה מתחילה מהיום">טיפלתי שוב</button>}
                      <button className="btn-ghost btn-icon" aria-label="הסרה מהרשימה" onClick={() => remove.mutate(m.id)}><Trash2 /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <p className="mt-4 text-xs leading-relaxed text-fg-subtle">
        איך זה נבדק: אחרי כל עדכון מהבנקים. חיוב שהועבר מאומת כשמופיע חיוב באותו סכום בערך (±25%) מאותו בית עסק בחשבון החדש.
        חיוב שבוטל מאומת כשעבר יום החיוב הרגיל שלו ועוד כמה ימים, והחשבון עודכן אחרי זה בלי חיוב. חיוב מבית העסק בחשבון הישן אחרי הסימון מקפיץ התראה.
      </p>
    </>
  );
}
