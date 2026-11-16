import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

interface TaskState { state: 'idle' | 'running' | 'success' | 'error'; message?: string; url?: string; code?: string }
interface SetupStatus {
  kiro: { installed: boolean; loggedIn: boolean; account: string | null; login: TaskState; install: TaskState };
  gemini: { bundled: boolean; hasKey: boolean; keyFromEnv: boolean };
}

const Dot = ({ ok }: { ok: boolean }) => <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${ok ? 'bg-green-500' : 'bg-amber-500'}`} />;

function useSetup() {
  return useQuery({
    queryKey: ['agent-setup'],
    queryFn: () => api.get<SetupStatus>('/agent/setup'),
    // while a sign-in / install runs, keep checking until it ends
    refetchInterval: q => {
      const k = q.state.data?.kiro;
      return k && (k.login.state === 'running' || k.install.state === 'running') ? 2000 : false;
    },
  });
}

/** Kiro: installed? signed in? — with buttons that do it from here (no terminal). */
export function KiroSetup() {
  const qc = useQueryClient();
  const setup = useSetup();
  const refresh = () => qc.invalidateQueries({ queryKey: ['agent-setup'] });
  const login = useMutation({ mutationFn: (deviceFlow: boolean) => api.post('/agent/kiro/login', { deviceFlow }), onSuccess: refresh });
  const install = useMutation({ mutationFn: () => api.post('/agent/kiro/install', {}), onSuccess: refresh });
  const k = setup.data?.kiro;
  if (!k) return <p className="text-sm text-zinc-500">בודק את Kiro…</p>;

  if (!k.installed) {
    return (
      <div className="space-y-2 text-sm">
        <p className="flex items-center gap-2"><Dot ok={false} />Kiro CLI לא מותקן במחשב.</p>
        <button className="btn btn-primary" disabled={k.install.state === 'running'} onClick={() => install.mutate()}>
          {k.install.state === 'running' ? 'מתקין… (אשרו את חלון ההרשאות של Windows)' : 'התקן את Kiro'}
        </button>
        {k.install.state === 'error' && <p className="text-red-600">{k.install.message}</p>}
      </div>
    );
  }
  if (k.loggedIn) {
    return (
      <p className="flex items-center gap-2 text-sm"><Dot ok />מחובר ל-Kiro{k.account ? <> בתור <b dir="ltr">{k.account}</b></> : null}. אפשר לשאול בצ׳אט (✨).</p>
    );
  }
  const running = k.login.state === 'running';
  return (
    <div className="space-y-2 text-sm">
      <p className="flex items-center gap-2"><Dot ok={false} />Kiro מותקן אבל לא מחובר.</p>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={running} onClick={() => login.mutate(false)}>
          {running ? 'ממתין להתחברות בדפדפן…' : 'התחבר ל-Kiro'}
        </button>
        {!running && <button className="btn" onClick={() => login.mutate(true)}>התחבר עם קוד</button>}
      </div>
      {running && k.login.url && (
        <p>אם הדפדפן לא נפתח: <a className="underline" href={k.login.url} target="_blank" rel="noreferrer" dir="ltr">{k.login.url}</a>
          {k.login.code && <> · קוד: <b dir="ltr">{k.login.code}</b></>}</p>
      )}
      {k.login.state === 'error' && <p className="text-red-600">{k.login.message}</p>}
    </div>
  );
}

/** Gemini: shipped with the app; needs only an API key, pasted once. */
export function GeminiSetup() {
  const qc = useQueryClient();
  const setup = useSetup();
  const [key, setKey] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['agent-setup'] });
  const save = useMutation({ mutationFn: (k: string) => api.put('/agent/gemini/key', { key: k }), onSuccess: () => { setKey(''); refresh(); } });
  const remove = useMutation({ mutationFn: () => api.del('/agent/gemini/key'), onSuccess: refresh });
  const g = setup.data?.gemini;
  if (!g) return <p className="text-sm text-zinc-500">בודק את Gemini…</p>;

  if (g.hasKey) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Dot ok />Gemini מחובר עם מפתח API. אפשר לשאול בצ׳אט (✨).
        {!g.keyFromEnv && <button className="btn btn-sm" onClick={() => remove.mutate()}>החלף מפתח</button>}
      </div>
    );
  }
  return (
    <div className="space-y-2 text-sm">
      <p className="flex items-center gap-2"><Dot ok={false} />צריך מפתח Gemini API (פעם אחת, בחינם):</p>
      <ol className="list-decimal space-y-1 ps-5 text-zinc-600">
        <li>פתחו את <a className="underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" dir="ltr">aistudio.google.com/apikey</a> והתחברו עם חשבון Google.</li>
        <li>לחצו ״Create API key״ והעתיקו את המפתח.</li>
        <li>הדביקו כאן ושמרו.</li>
      </ol>
      <div className="flex max-w-xl gap-2">
        <input className="input" dir="ltr" type="password" placeholder="AIza…" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" />
        <button className="btn btn-primary" disabled={!key.trim() || save.isPending} onClick={() => save.mutate(key.trim())}>שמור</button>
      </div>
      {save.isError && <p className="text-red-600">{(save.error as Error).message}</p>}
      {!g.bundled && <p className="text-xs text-zinc-500">Gemini CLI לא נמצא בהתקנה הזו (<code dir="ltr">npm install</code> מתקין אותו).</p>}
    </div>
  );
}
