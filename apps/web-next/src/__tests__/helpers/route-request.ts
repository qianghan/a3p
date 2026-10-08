import { NextRequest, NextResponse } from 'next/server';

export const TENANT_HEADER = 'x-test-tenant';

/**
 * Module body for `vi.mock('@/lib/agentbook-tenant', …)`.
 * The tenant comes from the x-test-tenant header (default 't1');
 * 'none' answers 401 exactly like the real resolver does without a session.
 */
export const tenantModuleMock = {
  safeResolveAgentbookTenant: async (req: NextRequest) => {
    const tenant = req.headers.get(TENANT_HEADER) ?? 't1';
    if (tenant === 'none') {
      return { response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
    }
    return { tenantId: tenant };
  },
};

export interface ReqInit {
  method?: string;
  body?: unknown;
  form?: FormData;
}

export function tenantReq(path: string, tenant = 't1', init: ReqInit = {}): NextRequest {
  const headers: Record<string, string> = { [TENANT_HEADER]: tenant };
  let body: BodyInit | undefined;
  if (init.form) {
    body = init.form;
  } else if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  return new NextRequest(new URL(path, 'http://test.local'), {
    method: init.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
  });
}

export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
