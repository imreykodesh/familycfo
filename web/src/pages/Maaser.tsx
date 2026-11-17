import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HandHeart, HandCoins, Settings2, Wallet, X } from 'lucide-react';
import { api, type MaaserConfig, type MaaserReport } from '../api';
import { useLookups } from '../state';
import { monthName } from '../format';
import { CategorySelect, Empty, ErrorBox, Field, Loading, Money, PageHeader, SectionTitle, Segmented, Stat } from '../components/ui';

export default function Maaser() {
  const qc = useQueryClient();
  const { category } = useLookups();
  const { data, isLoading, error } = useQuery({ queryKey: ['maaser'], queryFn: () => api.get<MaaserReport>('/maaser') });
  const [editing, setEditing] = useState(false);
  const [pattern, setPattern] = useState('');
  const save = useMutation({
    mutationFn: (b: Partial<MaaserConfig>) => api.put<MaaserReport>('/maaser/config', b),
    onSuccess: res => { qc.setQueryData(['maaser'], res); qc.invalidateQueries({ queryKey: ['meta'] }); },
  });

  if (isLoading) return <Loading />;
  if (error || !data) return <ErrorBox error={error} />;
  const { config: cfg, months, totals } = data;
  const current = months.at(-1);
  const pctLabel = cfg.percent === 10 ? 'מעשר' : cfg.percent === 20 ? 'חומש' : `${cfg.percent}%`;

  if (!cfg.enabled) {
    return (
      <>
        <PageHeader icon={HandHeart} title="מעשרות" subtitle="כמה צריך לתת לפי ההכנסות, כמה כבר ניתן, וכמה נשאר." />
        <div className="card max-w-2xl">
          <p className="text-sm leading-relaxed">
            האפליקציה מחשבת כל חודש {cfg.percent}% מההכנסות שנכנסו לחשבונות, ומשווה לתרומות: הוצאות בקטגוריה
            {' '}{data.donationCategories.length ? data.donationCategories.map(c => `„${c.name}"`).join(', ') : '„תרומה"'}.
            היתרה מצטברת מחודש לחודש. אפשר לשנות את האחוז, לחשב לפי ברוטו, ולהוציא הכנסות שלא חייבות במעשר.
          </p>
          <button className="btn btn-primary mt-4" disabled={save.isPending} onClick={() => save.mutate({ enabled: true })}><HandHeart />להתחיל לחשב</button>
        </div>
      </>
    );
  }

  const ids = (list: number[] | null) => list ?? data.donationCategories.map(c => c.id);
  const chip = (id: number, onRemove: () => void) => (
    <span key={id} className="chip">{category(id)?.name ?? id}<button aria-label="הסרה" onClick={onRemove}><X className="h-3 w-3" /></button></span>
  );

  return (
    <>
      <PageHeader icon={HandHeart} title="מעשרות"
        subtitle={`${pctLabel} מה${cfg.base === 'gross' ? 'ברוטו' : 'הכנסות נטו'}, מול התרומות. היתרה מצטברת מחודש לחודש${cfg.startMonth ? `, מ${monthName(cfg.startMonth)}` : ''}.`}
        actions={<button className="btn" onClick={() => setEditing(!editing)}><Settings2 />הגדרות</button>} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 md:gap-4">
        <Stat index={0} icon={HandCoins} color="var(--chart-5)" label={totals.remaining >= 0 ? 'נשאר לתת' : 'נתתם מעבר לנדרש'}
          value={Math.abs(totals.remaining)} tone={totals.remaining > 0 ? 'warn' : 'good'}
          hint={<>נדרש <Money value={totals.required} />, ניתן <Money value={totals.given} />{cfg.openingBalance ? <>, יתרת פתיחה <Money value={cfg.openingBalance} /></> : null}</>} />
        <Stat index={1} icon={Wallet} label="נדרש החודש" value={current?.required ?? 0}
          hint={current ? <>{cfg.percent}% מ-<Money value={current.income} />{current.partial && cfg.base === 'net' ? ' שנכנסו עד היום' : ''}</> : undefined} />
        <Stat index={2} icon={HandHeart} color="var(--positive)" label="ניתן החודש" value={current?.given ?? 0}
          hint={data.donationCategories.length ? `בקטגוריה ${data.donationCategories.map(c => c.name).join(', ')}` : 'לא נבחרה קטגוריית תרומות'} />
      </div>

      {editing && (
        <div className="card mt-4">
          <SectionTitle icon={Settings2}>הגדרות</SectionTitle>
          {save.error && <ErrorBox error={save.error} />}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <span className="label">כמה</span>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented value={cfg.percent === 10 || cfg.percent === 20 ? cfg.percent : undefined} onChange={p => p && save.mutate({ percent: p })}
                  options={[{ value: 10, label: 'מעשר 10%' }, { value: 20, label: 'חומש 20%' }]} />
                <input className="input num w-24" type="number" min={0} max={100} step={0.5} defaultValue={cfg.percent} key={cfg.percent} aria-label="אחוז"
                  onBlur={e => Number(e.target.value) !== cfg.percent && save.mutate({ percent: Number(e.target.value) })} />
              </div>
            </div>
            <div>
              <span className="label">לפי</span>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented value={cfg.base} onChange={base => save.mutate({ base })}
                  options={[{ value: 'net' as const, label: 'נטו — מה שנכנס לחשבון' }, { value: 'gross' as const, label: 'ברוטו — סכום קבוע' }]} />
                {cfg.base === 'gross' && (
                  <input className="input num w-32" type="number" min={0} placeholder="ברוטו בחודש" defaultValue={cfg.grossMonthly ?? ''} aria-label="ברוטו בחודש"
                    onBlur={e => save.mutate({ grossMonthly: e.target.value === '' ? null : Number(e.target.value) })} />
                )}
              </div>
            </div>
            <div>
              <span className="label">קטגוריות שנחשבות תרומה</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {ids(cfg.donationCategoryIds).map(id => chip(id, () => save.mutate({ donationCategoryIds: ids(cfg.donationCategoryIds).filter(x => x !== id) })))}
                <div className="w-52"><CategorySelect value={null} emptyLabel="+ קטגוריה" onChange={id => id && save.mutate({ donationCategoryIds: [...new Set([...ids(cfg.donationCategoryIds), id])] })} /></div>
              </div>
            </div>
            <div>
              <span className="label">הכנסות שלא נכללות (קטגוריות)</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {cfg.excludeCategoryIds.map(id => chip(id, () => save.mutate({ excludeCategoryIds: cfg.excludeCategoryIds.filter(x => x !== id) })))}
                <div className="w-52"><CategorySelect value={null} emptyLabel="+ קטגוריה" onChange={id => id && save.mutate({ excludeCategoryIds: [...new Set([...cfg.excludeCategoryIds, id])] })} /></div>
              </div>
            </div>
            <div>
              <span className="label">הכנסות שלא נכללות (טקסט בתיאור, למשל „החזר מס" או „העברה מאבא")</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {cfg.excludePatterns.map(p => (
                  <span key={p} className="chip">{p}<button aria-label="הסרה" onClick={() => save.mutate({ excludePatterns: cfg.excludePatterns.filter(x => x !== p) })}><X className="h-3 w-3" /></button></span>
                ))}
                <form className="flex gap-1.5" onSubmit={e => { e.preventDefault(); if (pattern.trim()) { save.mutate({ excludePatterns: [...cfg.excludePatterns, pattern.trim()] }); setPattern(''); } }}>
                  <input className="input w-40" value={pattern} onChange={e => setPattern(e.target.value)} placeholder="טקסט" />
                  <button className="btn" disabled={!pattern.trim()}>הוסף</button>
                </form>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="מאיזה חודש לספור"><input className="input" type="month" defaultValue={cfg.startMonth ?? ''}
                onBlur={e => (e.target.value || null) !== cfg.startMonth && save.mutate({ startMonth: e.target.value || null })} /></Field>
              <Field label="יתרת פתיחה (+ חוב, − זכות)"><input className="input num" type="number" defaultValue={cfg.openingBalance}
                onBlur={e => Number(e.target.value || 0) !== cfg.openingBalance && save.mutate({ openingBalance: Number(e.target.value || 0) })} /></Field>
            </div>
          </div>
          <div className="mt-4 flex justify-end border-t border-line-soft pt-3">
            <button className="btn-ghost text-sm text-negative" onClick={() => save.mutate({ enabled: false })}>להפסיק לחשב מעשרות</button>
          </div>
        </div>
      )}

      <div className="card mt-4 p-0">
        <SectionTitle icon={HandCoins}>חודש אחרי חודש</SectionTitle>
        {months.length === 0 ? <div className="px-4 pb-4"><Empty>אין חודשים לחשב.</Empty></div> : (
          <div className="scroll-x"><table className="table">
            <thead><tr><th>חודש</th><th className="text-end">הכנסה</th><th className="text-end">נדרש</th><th className="text-end">ניתן</th><th className="text-end">יתרה מצטברת</th></tr></thead>
            <tbody>
              {[...months].reverse().map(m => (
                <tr key={m.cycle.key}>
                  <td className="whitespace-nowrap">{monthName(m.cycle.key)}{m.partial && <span className="ms-1 text-xs text-fg-subtle">(עד היום)</span>}</td>
                  <td className="text-end"><Money value={m.income} />{m.excluded > 0 && <div className="text-xs text-fg-subtle">לא נכללו <Money value={m.excluded} /></div>}</td>
                  <td className="text-end"><Money value={m.required} /></td>
                  <td className="text-end">
                    {data.donationCategories.length === 1
                      ? <Link className="hover:underline" to={`/transactions?cycle=${m.cycle.key}&category=${data.donationCategories[0].id}`}><Money value={m.given} /></Link>
                      : <Money value={m.given} />}
                  </td>
                  <td className={`text-end font-medium ${m.balance > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-positive'}`}>
                    <Money value={Math.abs(m.balance)} /> <span className="text-xs font-normal">{m.balance > 0 ? 'לתת' : m.balance < 0 ? 'זכות' : ''}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
        ההכנסה היא מה שנכנס לחשבונות כהכנסה (משכורות, קצבאות, הכנסות אחרות). העברות בין החשבונות שלכם, החזרים שקושרו להוצאה וזיכויים לא נספרים.
        התרומות הן ההוצאות בקטגוריות שנבחרו (כולל תתי-קטגוריות). לא תרומה שסווגה? אפשר לשנות לה קטגוריה במסך התנועות.
      </p>
    </>
  );
}
