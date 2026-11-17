import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Meta } from './api';

export interface Filters {
  memberId?: number;
  businessId?: number;
  tagIds: number[];
}

interface Ctx {
  filters: Filters;
  setFilters: (f: Filters) => void;
  /** query params shared by every filtered endpoint */
  params: { member?: number; business?: number; tags?: number[] };
}

const FiltersContext = createContext<Ctx | null>(null);

export function FiltersProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<Filters>({ tagIds: [] });
  const value = useMemo(() => ({
    filters, setFilters,
    params: { member: filters.memberId, business: filters.businessId, tags: filters.tagIds },
  }), [filters]);
  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters(): Ctx {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error('useFilters outside FiltersProvider');
  return ctx;
}

export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/meta'), staleTime: 60_000 });
}

/** Screens always in the menu in the simple mode (settings comes last). */
export const MAIN_SCREENS = ['/', '/transactions', '/budgets', '/cashflow', '/settings'];

/**
 * Simple mode (the default): the menu shows the main screens + the ones the user pinned, the rest sit under
 * "עוד כלים", and the overview shows only the essentials. Full mode = every screen and the full overview.
 */
export function useUiMode() {
  const { data } = useMeta();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (b: Record<string, string>) => api.put('/settings', b),
    onMutate: b => qc.setQueryData<Meta>(['meta'], m => (m ? { ...m, settings: { ...m.settings, ...b } } : m)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['meta'] }),
  });
  const settings = data?.settings ?? {};
  const simple = settings.ui_mode !== 'full';
  const pinned = (() => {
    if (settings.nav_pinned == null) {
      // until the user pins anything: maaser stays in the menu when it's turned on
      try { return JSON.parse(settings.maaser_cfg ?? '{}').enabled === true ? ['/maaser'] : []; } catch { return []; }
    }
    try { const v = JSON.parse(settings.nav_pinned); return Array.isArray(v) ? (v as string[]) : []; } catch { return []; }
  })();
  return {
    simple,
    pinned,
    setSimple: (on: boolean) => save.mutate({ ui_mode: on ? 'simple' : 'full' }),
    togglePin: (path: string) => save.mutate({
      nav_pinned: JSON.stringify(pinned.includes(path) ? pinned.filter(p => p !== path) : [...pinned, path]),
    }),
  };
}

/** Lookup helpers over meta. */
export function useLookups() {
  const { data } = useMeta();
  return useMemo(() => {
    const members = new Map((data?.members ?? []).map(m => [m.id, m]));
    const accounts = new Map((data?.accounts ?? []).map(a => [a.id, a]));
    const categories = new Map((data?.categories ?? []).map(c => [c.id, c]));
    const businesses = new Map((data?.businesses ?? []).map(b => [b.id, b]));
    const tags = new Map((data?.tags ?? []).map(t => [t.id, t]));
    return {
      meta: data,
      member: (id: number | null | undefined) => (id == null ? undefined : members.get(id)),
      accountName: (id: string | null | undefined) => (id ? accounts.get(id)?.displayName ?? id : '—'),
      category: (id: number | null | undefined) => (id == null ? undefined : categories.get(id)),
      business: (id: number | null | undefined) => (id == null ? undefined : businesses.get(id)),
      tag: (id: number) => tags.get(id),
    };
  }, [data]);
}
