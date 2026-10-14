import type { ExpenseCategory } from '@/lib/mobile/types';
import { readJson, writeJson } from './safe-storage';

export const RECENTS_KEY = 'ab:mobile:category-recents';
const MAX_RECENTS = 5;

/** Stored with the name so Capture can show recent chips while offline. */
export type RecentCategory = Pick<ExpenseCategory, 'id' | 'name'>;

function isRecent(v: unknown): v is RecentCategory {
  return !!v && typeof v === 'object'
    && typeof (v as RecentCategory).id === 'string'
    && typeof (v as RecentCategory).name === 'string';
}

export function getRecentCategories(): RecentCategory[] {
  const raw = readJson<unknown>('local', RECENTS_KEY, []);
  return Array.isArray(raw) ? raw.filter(isRecent).slice(0, MAX_RECENTS) : [];
}

export function pushRecentCategory(c: RecentCategory): RecentCategory[] {
  const next = [{ id: c.id, name: c.name }, ...getRecentCategories().filter((r) => r.id !== c.id)].slice(0, MAX_RECENTS);
  writeJson('local', RECENTS_KEY, next);
  return next;
}

export function orderWithRecents(
  all: ExpenseCategory[],
  recents: RecentCategory[],
): { recent: ExpenseCategory[]; rest: ExpenseCategory[] } {
  const byId = new Map(all.map((c) => [c.id, c]));
  const recent = recents.map((r) => byId.get(r.id)).filter((c): c is ExpenseCategory => !!c);
  const taken = new Set(recent.map((c) => c.id));
  const rest = all.filter((c) => !taken.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
  return { recent, rest };
}
