import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, FileText, History, RefreshCw, ScrollText, Sparkles } from 'lucide-react';
import { api, qs, type LogLine, type ScrapeRun, type SyncStatus } from '../api';
import { day } from '../format';
import { Empty, ErrorBox, Loading, PageHeader, SectionTitle, Segmented } from '../components/ui';
import { companyName } from '../components/ScrapeButton';
import { askAgent } from '../components/AgentChat';
import { cn } from '@/lib/utils';

/** Scrape runs are stored in UTC ("YYYY-MM-DD HH:MM:SS" or ISO) — shown in Israel time. */
function when(utc: string | null): string {
  if (!utc) return '—';
  const d = new Date(utc.includes('T') ? utc : `${utc.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? utc : new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

/** The question the "explain" button sends: the error itself, never the page text (it may hold personal details). */
function explainQuestion(r: { company: string; startedAt: string; errorType: string | null; errorMessage: string | null }): string {
  const message = (r.errorMessage ?? '').split('\n')[0].slice(0, 300);
  return `העדכון מ${companyName(r.company)} (${r.company}) נכשל ב-${when(r.startedAt)}: ${r.errorType ?? 'שגיאה'}${message ? ` — ${message}` : ''}. מה כנראה קרה ומה לעשות?`;
}

const LEVEL_STYLE: Record<LogLine['level'], string> = {
  error: 'text-red-700 dark:text-red-300', warn: 'text-amber-700 dark:text-amber-300', info: 'text-fg', debug: 'text-muted-foreground',
};

export default function Logs() {
  const status = useQuery({ queryKey: ['sync'], queryFn: () => api.get<SyncStatus[]>('/sync-status') });
  const [failedOnly, setFailedOnly] = useState(false);
  const runs = useQuery({
    queryKey: ['scrape-runs', failedOnly],
    queryFn: () => api.get<ScrapeRun[]>(`/scrape/runs${qs({ failed: failedOnly ? 1 : undefined, limit: 100 })}`),
  });
  const [level, setLevel] = useState<'warn' | 'error' | 'info'>('warn');
  const [days, setDays] = useState(2);
  const [search, setSearch] = useState('');
  const logs = useQuery({
    queryKey: ['logs', level, days, search],
    queryFn: () => api.get<{ dir: string; files: string[]; lines: LogLine[] }>(`/logs${qs({ level, days, search, limit: 800 })}`),
  });
  const [open, setOpen] = useState<number | null>(null);

  const failing = status.data?.filter(s => !s.success) ?? [];

  return (
    <>
      <PageHeader title="יומן ותקלות" icon={ScrollText}
        subtitle={status.data ? (failing.length ? `${failing.length} מתוך ${status.data.length} לא התעדכנו בפעם האחרונה` : 'כל החשבונות התעדכנו בפעם האחרונה') : undefined}
        actions={<button className="btn" onClick={() => { status.refetch(); runs.refetch(); logs.refetch(); }}><RefreshCw />רענון</button>} />

      {status.error ? <ErrorBox error={status.error} /> : !status.data ? <Loading /> : !status.data.length ? (
        <Empty>עוד לא נרשמו עדכונים. אחרי הלחיצה הראשונה על ״עדכון נתונים״ יופיע כאן המצב של כל בנק וכרטיס.</Empty>
      ) : (
        <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {status.data.map(s => (
            <div key={s.company} className={cn('card animate-rise-in space-y-2', !s.success && 'border-rose-200 dark:border-rose-900/60')}>
              <div className="flex items-center gap-2">
                {s.success ? <CircleCheck className="h-5 w-5 shrink-0 text-emerald-600" /> : <CircleAlert className="h-5 w-5 shrink-0 text-rose-600" />}
                <span className="font-semibold">{companyName(s.company)}</span>
                <span className="ms-auto text-xs text-muted-foreground">{when(s.startedAt)}</span>
              </div>
              {s.success ? (
                <div className="text-sm text-muted-foreground">התעדכן · {s.newTransactions ? `${s.newTransactions} תנועות חדשות` : 'אין תנועות חדשות'}</div>
              ) : (
                <>
                  <div className="text-sm font-medium text-rose-700 dark:text-rose-300">{s.explanation?.title ?? s.errorType}</div>
                  {s.explanation && <p className="text-sm leading-relaxed text-muted-foreground">{s.explanation.hint}</p>}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {s.failuresInARow > 1 && <span>{s.failuresInARow} ניסיונות כושלים ברצף</span>}
                    <span>הצלחה אחרונה: {s.lastSuccess ? when(s.lastSuccess) : 'אף פעם'}</span>
                    {s.explanation && !s.explanation.retry && <span className="font-medium text-amber-700 dark:text-amber-300">לא לנסות שוב לפני שמתקנים</span>}
                  </div>
                  <button className="btn" onClick={() => askAgent(explainQuestion(s), true)}><Sparkles />הסבר עם העוזר</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <section className="card animate-rise-in mb-4">
        <SectionTitle icon={History} color="var(--chart-2)" as="h2"
          action={<Segmented value={failedOnly ? 'failed' : 'all'} onChange={v => setFailedOnly(v === 'failed')}
            options={[{ value: 'all', label: 'הכל' }, { value: 'failed', label: 'רק כישלונות' }]} />}>
          היסטוריית עדכונים
        </SectionTitle>
        {runs.error ? <ErrorBox error={runs.error} /> : !runs.data ? <Loading /> : !runs.data.length ? <Empty>אין עדכונים להצגה</Empty> : (
          <div className="scroll-x card-bleed"><table className="table">
            <thead><tr><th>מתי</th><th>חברה</th><th>תוצאה</th><th>מתאריך</th><th className="text-end">משך</th><th className="text-end">חדשות</th></tr></thead>
            <tbody>
              {runs.data.map(r => (
                <Fragment key={r.id}>
                  <tr className={cn(!r.success && 'cursor-pointer')} onClick={() => !r.success && setOpen(open === r.id ? null : r.id)}>
                    <td className="whitespace-nowrap text-xs">{when(r.startedAt)}</td>
                    <td>{companyName(r.company)}</td>
                    <td>{r.success ? <span className="text-emerald-600">✓ הצליח</span>
                      : <span className="text-rose-600">✗ {r.explanation?.title ?? r.errorType}</span>}</td>
                    <td className="text-xs">{r.startDate ? day(r.startDate) : '—'}</td>
                    <td className="text-end text-xs">{r.durationSeconds != null ? `${r.durationSeconds} שנ׳` : '—'}</td>
                    <td className="text-end">{r.newTransactions}</td>
                  </tr>
                  {open === r.id && (
                    <tr>
                      <td colSpan={6} className="space-y-2 bg-muted/40 text-xs">
                        {r.explanation && <p className="text-sm">{r.explanation.hint}</p>}
                        <div><span className="font-semibold">סוג שגיאה:</span> <code dir="ltr">{r.errorType}</code></div>
                        {r.errorMessage && <pre dir="ltr" className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-start">{r.errorMessage}</pre>}
                        {r.pageState && (
                          <details>
                            <summary className="cursor-pointer font-semibold">מה הופיע בעמוד של הבנק כשנסגר</summary>
                            <pre dir="auto" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background p-2">{r.pageState}</pre>
                          </details>
                        )}
                        <button className="btn" onClick={() => askAgent(explainQuestion(r), true)}><Sparkles />הסבר עם העוזר</button>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      <section className="card animate-rise-in mb-4">
        <SectionTitle icon={FileText} color="var(--chart-5)" as="h2"
          action={<Segmented value={level} onChange={setLevel}
            options={[{ value: 'error', label: 'שגיאות' }, { value: 'warn', label: 'אזהרות ושגיאות' }, { value: 'info', label: 'הכל' }]} />}>
          קובץ היומן
        </SectionTitle>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input className="input max-w-xs" placeholder="חיפוש ביומן (למשל שם בנק)" value={search} onChange={e => setSearch(e.target.value)} dir="auto" />
          <Segmented value={days} onChange={setDays} options={[{ value: 1, label: 'היום' }, { value: 2, label: 'יומיים' }, { value: 7, label: 'שבוע' }, { value: 14, label: 'שבועיים' }]} />
        </div>
        {logs.error ? <ErrorBox error={logs.error} /> : !logs.data ? <Loading /> : !logs.data.lines.length ? (
          <Empty>אין שורות ביומן לתקופה ולסינון האלה.{logs.data.dir && <><br /><span className="text-xs" dir="ltr">{logs.data.dir}</span></>}</Empty>
        ) : (
          <>
            <div dir="ltr" className="max-h-[32rem] overflow-auto rounded-lg border bg-muted/30 p-2 font-mono text-[11.5px] leading-relaxed">
              {logs.data.lines.map((l, i) => (
                <div key={i} className={cn('whitespace-pre-wrap break-words', LEVEL_STYLE[l.level])}>
                  <span className="text-muted-foreground">{l.time.slice(5)} {l.source.padEnd(6)}</span> {l.text}
                </div>
              ))}
            </div>
            <div className="mt-2 text-xs text-muted-foreground" dir="auto">
              {logs.data.lines.length} שורות · הקבצים נשמרים במחשב בלבד: <span dir="ltr">{logs.data.dir}</span>
            </div>
          </>
        )}
      </section>
    </>
  );
}
