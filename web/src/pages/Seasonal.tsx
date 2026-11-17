import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CircleCheck, Gift, History, Pencil, PiggyBank, Plus, Trash2 } from 'lucide-react';
import { api, type EventCalendar, type SeasonalEvent, type SeasonalPlan } from '../api';
import { day, money } from '../format';
import { Empty, ErrorBox, Field, Loading, Modal, Money, PageHeader, Picker, SectionTitle, Segmented, Stat } from '../components/ui';
import { hueFor } from '@/lib/visuals';

const HEBREW_MONTHS: [string, string][] = [
  ['Tishri', 'תשרי'], ['Heshvan', 'חשוון'], ['Kislev', 'כסלו'], ['Tevet', 'טבת'], ['Shevat', 'שבט'], ['Adar', 'אדר (בשנה מעוברת: אדר ב׳)'],
  ['Nisan', 'ניסן'], ['Iyar', 'אייר'], ['Sivan', 'סיוון'], ['Tamuz', 'תמוז'], ['Av', 'אב'], ['Elul', 'אלול'],
];
const GREGORIAN_MONTHS = Array.from({ length: 12 }, (_, i) =>
  [String(i + 1), new Intl.DateTimeFormat('he-IL', { month: 'long' }).format(new Date(2026, i, 1))] as [string, string]);

interface Draft { id?: number; name: string; calendar: EventCalendar; month: string; day: number; amount: number | ''; notes: string }

const inDays = (n: number) => (n === 0 ? 'היום' : n === 1 ? 'מחר' : `בעוד ${n} ימים`);

export default function Seasonal() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['seasonal'], queryFn: () => api.get<SeasonalPlan>('/seasonal') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pot, setPot] = useState<number | null>(null);
  const [settling, setSettling] = useState<{ event: SeasonalEvent; spent: number | '' } | null>(null);

  const refresh = () => { for (const k of ['seasonal', 'summary', 'meta', 'alerts']) qc.invalidateQueries({ queryKey: [k] }); };
  const save = useMutation({
    mutationFn: ({ id, ...body }: Draft) => (id ? api.patch(`/seasonal/${id}`, body) : api.post('/seasonal', body)),
    onSuccess: () => { refresh(); setDraft(null); },
  });
  const remove = useMutation({ mutationFn: (id: number) => api.del(`/seasonal/${id}`), onSuccess: () => { refresh(); setDraft(null); } });
  const savePot = useMutation({ mutationFn: (balance: number) => api.put('/seasonal/pot', { balance }), onSuccess: () => { refresh(); setPot(null); } });
  const settle = useMutation({
    mutationFn: (s: { id: number; date: string; spent: number }) => api.post(`/seasonal/${s.id}/settle`, { date: s.date, spent: s.spent }),
    onSuccess: () => { refresh(); setSettling(null); },
  });

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;

  const pending = data.events.filter(e => e.pendingSettle);
  const active = data.events.filter(e => e.active);
  const months = (cal: EventCalendar) => (cal === 'hebrew' ? HEBREW_MONTHS : GREGORIAN_MONTHS);

  return (
    <>
      <PageHeader icon={Gift} title="קופה לאירועים צפויים"
        subtitle="חגים, חופש הגדול וכל הוצאה גדולה שחוזרת כל שנה. כמה להפריש כל חודש, כדי שהאירוע לא ישבור את החודש."
        actions={<button className="btn btn-primary" onClick={() => setDraft({ name: '', calendar: 'hebrew', month: 'Nisan', day: 15, amount: '', notes: '' })}><Plus />אירוע</button>} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 md:gap-4">
        <Stat index={0} icon={PiggyBank} color="var(--chart-2)" label="יתרה בקופה" value={data.pot.balance}
          hint={<button className="text-primary hover:underline" onClick={() => setPot(data.pot.balance)}>עדכון היתרה</button>} />
        <Stat index={1} icon={CalendarClock} label="להפריש בחודש" value={data.perMonth} tone={data.perMonth > 0 ? undefined : 'good'}
          hint={active.length === 0 ? 'עוד לא הוגדרו אירועים'
            : data.perMonth > 0 ? <>כדי שכל אירוע יהיה מכוסה בזמן. בשנה הקרובה חסרים <Money value={data.missing} /></>
            : 'הקופה מכסה את כל האירועים של השנה הקרובה'} />
        <Stat index={2} icon={Gift} color="var(--chart-6)" label="האירוע הקרוב"
          value={data.next ? <span className="text-lg sm:text-xl">{data.next.name}</span> : '—'}
          hint={data.next ? <>{data.next.dateLabel} · {day(data.next.nextDate)} · {inDays(data.next.daysUntil)} · <Money value={data.next.amount} /></> : undefined} />
      </div>

      {pending.length > 0 && (
        <div className="card mt-4 border-amber-300/70 bg-amber-50/60 dark:border-amber-800/60 dark:bg-amber-950/20">
          <SectionTitle icon={History} color="var(--chart-3)">אירועים שעברו — כמה יצא מהקופה?</SectionTitle>
          <p className="mb-3 text-sm text-fg-subtle">התשובה מורידה את הסכום מהיתרה בקופה, כדי שההפרשה החודשית תחושב נכון.</p>
          <div className="space-y-2">
            {pending.map(e => (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line-soft bg-card px-3 py-2.5">
                <div className="min-w-0"><span className="font-medium">{e.name}</span> <span className="text-xs text-fg-subtle">· {day(e.pendingSettle)}</span></div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn" onClick={() => settle.mutate({ id: e.id, date: e.pendingSettle!, spent: e.amount })}>כל הסכום: <Money value={e.amount} /></button>
                  <button className="btn" onClick={() => setSettling({ event: e, spent: '' })}>סכום אחר</button>
                  <button className="btn-ghost" onClick={() => settle.mutate({ id: e.id, date: e.pendingSettle!, spent: 0 })}>לא השתמשנו בקופה</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card mt-4 p-0">
        <SectionTitle icon={CalendarClock}>האירועים</SectionTitle>
        {data.events.length === 0 ? (
          <div className="px-4 pb-4 md:px-5 md:pb-5"><Empty>הוסיפו את האירועים הגדולים של השנה. אפשר להתחיל מההצעות למטה, עם סכום לפי מה שיצא בשנים הקודמות.</Empty></div>
        ) : (
          <div className="scroll-x"><table className="table">
            <thead><tr><th>אירוע</th><th>תאריך</th><th>הפעם הבאה</th><th className="text-end">סכום צפוי</th><th>בשנים קודמות</th><th>בקופה</th><th /></tr></thead>
            <tbody>
              {data.events.map(e => (
                <tr key={e.id} className={e.active ? '' : 'opacity-50'}>
                  <td className="min-w-36 font-medium">
                    <div className="flex items-center gap-2.5">
                      <span className="icon-tile h-8 w-8" style={{ ['--tile' as string]: hueFor(e.name) }}><Gift /></span>
                      <div className="min-w-0">{e.name}{e.notes && <div className="text-xs font-normal text-fg-subtle">{e.notes}</div>}</div>
                    </div>
                  </td>
                  <td className="whitespace-nowrap">{e.dateLabel}</td>
                  <td className="whitespace-nowrap text-sm">{day(e.nextDate)} <span className="text-xs text-fg-subtle">· {inDays(e.daysUntil)}</span></td>
                  <td className="text-end"><Money value={e.amount} /></td>
                  <td className="whitespace-nowrap text-xs text-fg-subtle">
                    {e.suggested != null ? <span title="ההוצאות המשתנות בשבועות סביב התאריך, מעבר לחודש רגיל">כ-{money(e.suggested)} מעל הרגיל</span> : 'אין מספיק היסטוריה'}
                  </td>
                  <td className="whitespace-nowrap text-sm">
                    {!e.active ? 'מושבת' : e.covered ? <span className="inline-flex items-center gap-1 text-positive"><CircleCheck className="h-4 w-4" />מכוסה</span> : <span className="text-fg-subtle">עוד לא</span>}
                  </td>
                  <td className="whitespace-nowrap">
                    <button className="btn-ghost btn-icon" aria-label="עריכה"
                      onClick={() => setDraft({ id: e.id, name: e.name, calendar: e.calendar, month: e.month, day: e.day, amount: e.amount, notes: e.notes ?? '' })}><Pencil /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>

      {data.suggestions.length > 0 && (
        <div className="card mt-4">
          <SectionTitle icon={Plus} color="var(--chart-5)">להוסיף בלחיצה</SectionTitle>
          <div className="flex flex-wrap gap-2">
            {data.suggestions.map(s => (
              <button key={s.key} className="btn" onClick={() => setDraft({ name: s.name, calendar: s.calendar, month: s.month, day: s.day, amount: s.suggested ?? '', notes: '' })}>
                <Plus />{s.name}{s.suggested != null && <span className="text-xs text-fg-subtle">· כ-{money(s.suggested)}</span>}
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-fg-subtle">הסכום המוצע: כמה יותר מחודש רגיל יצא בהוצאות המשתנות בשלושת השבועות שלפני התאריך ובשבוע שאחריו, בממוצע של השנים שיש עליהן נתונים.</p>
        </div>
      )}

      <p className="mt-4 text-xs leading-relaxed text-fg-subtle">
        איך מחושבת ההפרשה: האירועים ממוינים לפי התאריך, ולכל אירוע נבדק כמה חסר בקופה כדי לכסות אותו ואת כל מה שלפניו, חלקי מספר החודשים עד אליו.
        ההפרשה היא הגבוה מבין אלה, וכך כל אירוע מכוסה בזמן. היא מורדת מ״כמה אפשר להוציא ביום״ בסקירה.
      </p>

      {draft && (
        <Modal title={draft.id ? 'עריכת אירוע' : 'אירוע חדש'} onClose={() => setDraft(null)} footer={<>
          {draft.id && <button className="btn me-auto text-negative" onClick={() => remove.mutate(draft.id!)}><Trash2 />מחיקה</button>}
          <button className="btn" onClick={() => setDraft(null)}>ביטול</button>
          <button className="btn btn-primary" disabled={!draft.name.trim() || draft.amount === '' || save.isPending}
            onClick={() => save.mutate({ ...draft, amount: Number(draft.amount) })}>שמור</button>
        </>}>
          {save.error && <ErrorBox error={save.error} />}
          <Field label="שם"><input className="input" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="למשל: פסח" /></Field>
          <div>
            <span className="label">לוח שנה</span>
            <Segmented value={draft.calendar} onChange={calendar => setDraft({ ...draft, calendar, month: calendar === 'hebrew' ? 'Nisan' : '9', day: Math.min(draft.day, calendar === 'hebrew' ? 30 : 31) })}
              options={[{ value: 'hebrew' as EventCalendar, label: 'עברי' }, { value: 'gregorian' as EventCalendar, label: 'לועזי' }]} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="חודש"><Picker value={draft.month} onChange={v => v && setDraft({ ...draft, month: v })}
              options={months(draft.calendar).map(([value, label]) => ({ value, label }))} /></Field>
            <Field label="יום בחודש"><input className="input num" type="number" min={1} max={draft.calendar === 'hebrew' ? 30 : 31} value={draft.day}
              onChange={e => setDraft({ ...draft, day: Number(e.target.value) })} /></Field>
            <Field label="סכום צפוי (₪)"><input className="input num" type="number" min={0} value={draft.amount}
              onChange={e => setDraft({ ...draft, amount: e.target.value === '' ? '' : Number(e.target.value) })} /></Field>
          </div>
          <Field label="הערות"><input className="input" value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} placeholder="מתנות, אירוח, בגדים…" /></Field>
          <p className="text-xs text-fg-subtle">יום שלא קיים בחודש באותה שנה (למשל ל׳ בחשוון בשנה חסרה) נופל על היום האחרון של החודש.</p>
        </Modal>
      )}

      {pot != null && (
        <Modal title="יתרה בקופה לאירועים" onClose={() => setPot(null)} footer={<>
          <button className="btn" onClick={() => setPot(null)}>ביטול</button>
          <button className="btn btn-primary" onClick={() => savePot.mutate(pot)}>שמור</button>
        </>}>
          <Field label="כמה כסף יש היום בקופה (₪)"><input className="input num" type="number" value={pot} onChange={e => setPot(Number(e.target.value))} /></Field>
          <p className="text-xs text-fg-subtle">כשמפרישים לקופה, מעדכנים כאן את היתרה. כסף שיצא בגלל אירוע יורד לבד, כשעונים על השאלה אחרי האירוע.</p>
        </Modal>
      )}

      {settling && (
        <Modal title={`כמה יצא מהקופה על ${settling.event.name}?`} onClose={() => setSettling(null)} footer={<>
          <button className="btn" onClick={() => setSettling(null)}>ביטול</button>
          <button className="btn btn-primary" disabled={settling.spent === ''}
            onClick={() => settle.mutate({ id: settling.event.id, date: settling.event.pendingSettle!, spent: Number(settling.spent) })}>שמור</button>
        </>}>
          <Field label="סכום (₪)"><input className="input num" type="number" min={0} autoFocus value={settling.spent}
            onChange={e => setSettling({ ...settling, spent: e.target.value === '' ? '' : Number(e.target.value) })} /></Field>
        </Modal>
      )}
    </>
  );
}
