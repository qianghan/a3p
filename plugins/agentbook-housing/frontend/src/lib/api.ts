const BASE = '/api/v1/agentbook-housing';

export interface Listing {
  id: string;
  title: string;
  status: string;
  sourceUrl: string | null;
  amountCents: number | null; // monthly rent
  currency: string | null;
  payload: { area?: string | null; commute?: string | null; leaseTerm?: string | null; notes?: string | null } & Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Affordability {
  hasIncome: boolean;
  monthlyIncomeCents: number;
  monthlySpendingCents: number;
  recommendedMaxRentCents: number | null;
  rentToIncome: number;
}

export interface ListingInput {
  title: string;
  rentCents?: number | null;
  sourceUrl?: string | null;
  area?: string | null;
  commute?: string | null;
  leaseTerm?: string | null;
  notes?: string | null;
}

export const STATUS_FLOW = ['considering', 'applied', 'toured', 'secured', 'passed'] as const;

async function json<T>(r: Response): Promise<T> {
  const body = (await r.json().catch(() => null)) as { success?: boolean; data?: T; error?: string } | null;
  if (!r.ok || !body?.success) throw new Error(body?.error || `${r.status}`);
  return body.data as T;
}

export const housingApi = {
  list: async (): Promise<Listing[]> =>
    json<Listing[]>(await fetch(`${BASE}/opportunities`, { credentials: 'include' })),

  affordability: async (): Promise<Affordability> =>
    json<Affordability>(await fetch(`${BASE}/affordability`, { credentials: 'include' })),

  save: async (input: ListingInput): Promise<Listing> =>
    json<Listing>(await fetch(`${BASE}/opportunities`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })),

  setStatus: async (id: string, status: string): Promise<Listing> =>
    json<Listing>(await fetch(`${BASE}/opportunities/${id}`, {
      method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    })),

  remove: async (id: string): Promise<void> => {
    const r = await fetch(`${BASE}/opportunities/${id}`, { method: 'DELETE', credentials: 'include' });
    if (!r.ok) throw new Error(`${r.status}`);
  },
};

export function fmtCents(cents: number | null): string {
  if (cents == null) return '—';
  return `$${Math.round(cents / 100).toLocaleString()}`;
}
