import { useRef, useState, type DragEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileUp } from 'lucide-react';
import { api } from '../api';
import { askAgent } from './AgentChat';
import { ErrorBox, Modal } from './ui';
import { cn } from '@/lib/utils';

/**
 * "ייבוא דוח" on the pension, insurance and loans screens. A PDF / image is saved in data/reports and handed to the
 * data chat, which reads it and puts its numbers in the app (skill import-document). A report already extracted to
 * JSON (docs/importing.md) is imported directly, no chat needed.
 */
type Kind = 'pension' | 'insurance' | 'loans';

const TEXT: Record<Kind, { title: string; what: string; ask: string; json: boolean }> = {
  pension: {
    title: 'ייבוא דוח פנסיה וגמל',
    what: 'דוח תקופתי מהסוכן, דוח מהמסלקה הפנסיונית או דוח שנתי של קרן פנסיה, קרן השתלמות או קופת גמל.',
    ask: 'תייבא לאפליקציה את דוח הפנסיה והחיסכון',
    json: true,
  },
  insurance: {
    title: 'ייבוא דוח ביטוחים',
    what: 'דוח מהר הביטוח, דף פרטי ביטוח או סיכום פוליסות מהסוכן. (מסמך של פוליסה מסוימת אפשר גם לגרור לתוך הפוליסה עצמה.)',
    ask: 'תייבא לאפליקציה את הביטוחים מהדוח',
    json: true,
  },
  loans: {
    title: 'ייבוא דוח משכנתא או הלוואה',
    what: 'דוח יתרות משכנתא מהבנק, אישור יתרה לסילוק או לוח סילוקין של הלוואה.',
    ask: 'תייבא לאפליקציה את המשכנתא / ההלוואה מהדוח',
    json: false,
  },
};

const MIME_BY_EXT: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const extOf = (f: File) => f.name.split('.').pop()?.toLowerCase() ?? '';

interface PensionResult { assets: number; created: number; deposits: number; policies: number }
interface InsuranceResult { created: number; updated: number; documents: number; snapshots: number }

export function ImportDocumentsButton({ kind, primary }: { kind: Kind; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={cn('btn', primary && 'btn-primary')} onClick={() => setOpen(true)}><FileUp />ייבוא דוח</button>
      {open && <ImportDocuments kind={kind} onClose={() => setOpen(false)} />}
    </>
  );
}

function ImportDocuments({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const t = TEXT[kind];
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const run = useMutation({
    mutationFn: async (files: File[]) => {
      const json = t.json ? files.filter(f => extOf(f) === 'json') : [];
      const docs = files.filter(f => !json.includes(f));
      const unsupported = docs.filter(f => !MIME_BY_EXT[extOf(f)]);
      if (unsupported.length) throw new Error(`אפשר לייבא רק PDF או תמונה${t.json ? ' (או קובץ JSON)' : ''}: ${unsupported.map(f => f.name).join(', ')}`);

      // documents first: a JSON insurance file may attach them
      const paths: string[] = [];
      for (const file of docs) {
        const res = await fetch(`/api/reports/upload?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'content-type': MIME_BY_EXT[extOf(file)] }, body: file,
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`${file.name}: ${body?.error ?? res.statusText}`);
        paths.push(body.path);
      }

      const results: string[] = [];
      for (const file of json) {
        let data: unknown;
        try { data = JSON.parse(await file.text()); } catch { throw new Error(`${file.name}: הקובץ אינו JSON תקין`); }
        if (kind === 'pension') {
          const r = await api.post<PensionResult>('/pension/import', data);
          results.push(`${file.name}: ${r.assets} מוצרים (${r.created} חדשים), ${r.deposits} שורות הפקדה, ${r.policies} ביטוחים`);
        } else {
          const r = await api.post<InsuranceResult>('/insurance/import', data);
          results.push(`${file.name}: ${r.created} פוליסות חדשות, ${r.updated} עודכנו, ${r.documents} מסמכים צורפו`);
        }
      }
      return { paths, results, sendToAgent: json.length === 0 && paths.length > 0 };
    },
    onSuccess: ({ paths, sendToAgent }) => {
      for (const k of ['pension', 'insurance', 'liabilities', 'networth', 'assets', 'summary']) qc.invalidateQueries({ queryKey: [k] });
      if (sendToAgent) {
        onClose();
        askAgent(`${t.ask}: ${paths.map(p => `\`${p}\``).join(', ')}`, true);
      }
    },
  });

  const pick = (files: File[]) => { if (files.length && !run.isPending) run.mutate(files); };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); pick([...e.dataTransfer.files]); };
  const done = run.data;

  return (
    <Modal title={t.title} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>{done ? 'סגירה' : 'ביטול'}</button>}>
      <div className="space-y-3 text-sm leading-relaxed">
        <p>{t.what}</p>
        <div onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
          className={cn('flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center text-fg-subtle transition-colors',
            dragging && 'border-primary bg-primary/5')}>
          <FileUp className="h-6 w-6" />
          <span>גררו לכאן את הדוח (PDF או תמונה), או</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => input.current?.click()} disabled={run.isPending}>
            {run.isPending ? 'מייבא…' : 'בחירת קובץ'}
          </button>
          <input ref={input} type="file" multiple hidden
            accept={`application/pdf,image/png,image/jpeg,image/webp${t.json ? ',application/json,.json' : ''}`}
            onChange={e => { pick([...(e.target.files ?? [])]); e.target.value = ''; }} />
        </div>
        <p className="text-xs text-fg-subtle">
          הקובץ נשמר אצלכם במחשב. העוזר (✨) קורא אותו, מכניס את הנתונים לאפליקציה ומראה מה נכנס. ייבוא חוזר של אותו דוח מעדכן ולא משכפל.
        </p>
        {run.error && <ErrorBox error={run.error} />}
        {done && done.results.length > 0 && (
          <div className="space-y-1 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200">
            {done.results.map(r => <div key={r} className="flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 shrink-0" />{r}</div>)}
          </div>
        )}
      </div>
    </Modal>
  );
}
