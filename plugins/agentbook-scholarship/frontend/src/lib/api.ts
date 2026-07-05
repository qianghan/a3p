const BASE = '/api/v1/agentbook-scholarship';

export interface Opportunity {
  id: string;
  title: string;
  status: string;
  sourceUrl: string | null;
  sourceLabel: string | null;
  deadline: string | null;
  payload: { amountText?: string | null; eligibilitySummary?: string | null } & Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Candidate {
  title: string;
  amountText: string | null;
  deadlineText: string | null;
  eligibilitySummary: string;
  sourceUrl: string;
  sourceLabel: string;
}

export const STATUS_FLOW = ['shortlisted', 'preparing', 'ready', 'submitted', 'closed'] as const;

async function json<T>(r: Response): Promise<T> {
  const body = (await r.json().catch(() => null)) as { success?: boolean; data?: T; error?: string } | null;
  if (!r.ok || !body?.success) {
    throw new Error(body?.error || `${r.status}`);
  }
  return body.data as T;
}

export const scholarshipApi = {
  list: async (): Promise<Opportunity[]> =>
    json<Opportunity[]>(await fetch(`${BASE}/opportunities`, { credentials: 'include' })),

  discover: async (query?: string): Promise<{ candidates: Candidate[]; note: string }> =>
    json(await fetch(`${BASE}/discover`, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }),
    })),

  save: async (c: Partial<Candidate> & { title: string }): Promise<Opportunity> =>
    json<Opportunity>(await fetch(`${BASE}/opportunities`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: c.title, sourceUrl: c.sourceUrl ?? null, sourceLabel: c.sourceLabel ?? null,
        deadline: c.deadlineText ?? null, amountText: c.amountText ?? null,
        eligibilitySummary: c.eligibilitySummary ?? null,
      }),
    })),

  setStatus: async (id: string, status: string): Promise<Opportunity> =>
    json<Opportunity>(await fetch(`${BASE}/opportunities/${id}`, {
      method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    })),

  remove: async (id: string): Promise<void> => {
    const r = await fetch(`${BASE}/opportunities/${id}`, { method: 'DELETE', credentials: 'include' });
    if (!r.ok) throw new Error(`${r.status}`);
  },
};
