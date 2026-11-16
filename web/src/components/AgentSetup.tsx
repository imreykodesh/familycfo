import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

interface TaskState { state: 'idle' | 'running' | 'success' | 'error'; message?: string; url?: string; code?: string }
interface SetupStatus {
  kiro: { installed: boolean; loggedIn: boolean; account: string | null; login: TaskState; install: TaskState };
  gemini: { bundled: boolean; hasKey: boolean; keyFromEnv: boolean };
}

interface AgentModel { id: string; name: string; description?: string; contextTokens?: number; rate?: number }
interface ModelList { models: AgentModel[]; defaultModel: string | null; error?: string; source?: string }

const tokens = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}K`);

/**
 * The provider's models, as its own tool / account lists them right now, and the one the chat uses.
 * Empty choice = the tool's default. Saved per provider (agent_model_<provider>).
 */
export function ModelPicker({ provider, value, onChange }: { provider: 'claude' | 'gemini' | 'kiro'; value: string; onChange: (id: string) => void }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['agent-models', provider],
    queryFn: () => api.get<ModelList>(`/agent/models?provider=${provider}`),
    staleTime: 5 * 60_000,
  });
  const refresh = useMutation({
    mutationFn: () => api.get<ModelList>(`/agent/models?provider=${provider}&refresh=1`),
    onSuccess: data => qc.setQueryData(['agent-models', provider], data),
  });
  const data = list.data;
  const models = data?.models ?? [];
  const loading = list.isLoading || refresh.isPending;
  // a saved model the list no longer offers (plan changed, model retired): keep showing it so it can be changed
  const missing = value && !models.some(m => m.id === value) && !loading && models.length > 0;
  const defaultName = data?.defaultModel ? (models.find(m => m.id === data.defaultModel)?.name ?? data.defaultModel) : null;
  const selected = models.find(m => m.id === value);

  return (
    <div className="mt-4 max-w-3xl space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">מודל</span>
        <select className="input max-w-md" dir="ltr" value={value} disabled={loading && !models.length} onChange={e => onChange(e.target.value)}>
          <option value="">{`ברירת המחדל${defaultName ? ` (${defaultName})` : ''}`}</option>
          {missing && <option value={value}>{`${value} — לא זמין יותר`}</option>}
          {models.map(m => (
            <option key={m.id} value={m.id}>
              {[m.name !== m.id ? `${m.name} (${m.id})` : m.id, m.rate != null ? `×${m.rate} קרדיטים` : null, m.contextTokens ? `${tokens(m.contextTokens)} הקשר` : null]
                .filter(Boolean).join(' · ')}
            </option>
          ))}
        </select>
        {provider !== 'claude' && (
          <button className="btn btn-sm" disabled={loading} onClick={() => refresh.mutate()}>{loading ? 'טוען…' : 'רענן רשימה'}</button>
        )}
      </div>
      {data?.error && <p className="text-amber-700">{data.error}</p>}
      {list.isError && <p className="text-red-600">{(list.error as Error).message}</p>}
      {missing && <p className="text-amber-700">המודל שנבחר לא מופיע עכשיו ברשימה של החשבון. בחרו מודל אחר או את ברירת המחדל.</p>}
      {selected?.description && <p className="text-zinc-500">{selected.description}</p>}
      {provider === 'claude' && <p className="text-xs text-zinc-500">Claude Code לא מציג רשימה: אלה הכינויים שהוא מקבל, וכל אחד מהם הוא הגרסה העדכנית של אותה משפחה.</p>}
      {provider === 'kiro' && models.length > 0 && <p className="text-xs text-zinc-500">הרשימה היא מה שהחשבון שלך ב-Kiro מאפשר כרגע. ״×2 קרדיטים״ = כל שאלה עולה פי 2 מהבסיס.</p>}
    </div>
  );
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
