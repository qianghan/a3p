const GATEWAY_BASE = process.env.SHELL_URL || 'http://localhost:3000';

export interface AuthContext {
  authorization?: string;
  cookie?: string;
  teamId?: string;
}

let globalAuthContext: AuthContext = {};

export function setAuthContext(ctx: AuthContext): void {
  globalAuthContext = ctx;
}

export function getAuthContext(): AuthContext {
  return globalAuthContext;
}

export async function gwFetch(
  connectorSlug: string,
  path: string,
  options: RequestInit = {},
  authContext?: AuthContext,
): Promise<Response> {
  const ctx = authContext || globalAuthContext;
  const headers = new Headers({
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  });

  if (ctx.authorization && !headers.has('Authorization')) {
    headers.set('Authorization', ctx.authorization);
  }
  if (ctx.cookie && !headers.has('Cookie')) {
    headers.set('Cookie', ctx.cookie);
  }
  if (ctx.teamId && !headers.has('x-team-id')) {
    headers.set('x-team-id', ctx.teamId);
  }

  const url = `${GATEWAY_BASE}/api/v1/gw/${connectorSlug}${path}`;
  return fetch(url, {
    ...options,
    headers,
  });
}
