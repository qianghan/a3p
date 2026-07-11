import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@/lib/api/auth';
import { getOAuthProvider } from '@/lib/mcp/oauth-provider';
import { nodeRequestResponseFromWeb } from '@/lib/mcp/node-web-adapter';
import { prisma } from '@naap/database';

// Finishes the interaction oidc-provider is waiting on: records/denies
// consent, then hands back the URL oidc-provider wants the browser to go to
// next (back to `/api/v1/oauth/authorize`, which issues the auth code).
//
// Uses the Task 4a adapter to give `interactionDetails`/`interactionResult` a
// real request/response — fake `{ headers: {} } as any` stand-ins would fail
// to locate the interaction's session cookie at runtime. `request.json()`
// and the adapter's own body read both consume the request's body stream, so
// the JSON payload is read via `clone()` first to avoid a double-read error.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const { uid, allow } = await request.clone().json();
  const token = request.cookies.get('naap_auth_token')?.value;
  const user = token ? await validateSession(token) : null;
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const provider = getOAuthProvider();
  const { nodeReq, nodeRes } = await nodeRequestResponseFromWeb(request);
  const details = await provider.interactionDetails(nodeReq, nodeRes);
  const clientId = details.params.client_id as string;

  let redirectTo: string;
  if (!allow) {
    redirectTo = await provider.interactionResult(nodeReq, nodeRes, { error: 'access_denied' });
  } else {
    await prisma.mcpConsentGrant.upsert({
      where: { userId_clientId: { userId: user.id, clientId } },
      create: { userId: user.id, clientId, scope: 'agentbook:full' },
      update: { revokedAt: null, grantedAt: new Date() },
    });

    // oidc-provider's own Grant object must actually exist before
    // interactionResult() can reference it — details.grantId is undefined
    // on a first-time consent (verified against
    // node_modules/oidc-provider/lib/actions/authorization/load_grant.js:
    // the library only creates an unsaved, in-memory Grant when none is
    // found; nothing persists it for us). Load the existing one on a
    // reconnect, otherwise create+save a new one, then reference whichever
    // grantId actually exists in storage.
    const grant = details.grantId
      ? await provider.Grant.find(details.grantId)
      : new provider.Grant({ accountId: user.id, clientId });
    grant.addOIDCScope('agentbook:full');
    const grantId = await grant.save();

    redirectTo = await provider.interactionResult(nodeReq, nodeRes, {
      login: { accountId: user.id },
      consent: { grantId },
    });
  }

  const response = NextResponse.json({ redirectTo, uid });

  // Verified against the pinned oidc-provider@9.9.1 source
  // (node_modules/oidc-provider/lib/provider.js `#getInteraction`,
  // `interactionDetails`, `interactionResult`): neither method ever writes to
  // `res`. `interactionDetails` only *reads* the `_interaction` cookie via
  // Koa's `ctx.cookies.get()`; `interactionResult` mutates the Interaction
  // model and persists it straight through the storage adapter
  // (`interaction.save()`), returning `interaction.returnTo` as a plain
  // string. The `cookies` package's `.get()` can, in principle, rewrite a
  // signed cookie's signature as a read-time side effect (key rotation) —
  // but only when `configuration.cookies.keys` is non-empty, which this
  // provider (see oauth-provider.ts) does not set, so that path is inert
  // here too. In short: this loop is a no-op today (`nodeRes.getHeaders()`
  // won't contain `set-cookie` for this flow) and is kept only as cheap
  // insurance against a future config/version change reintroducing
  // response-cookie writes on this codepath — it does not paper over any
  // currently-unverified behavior.
  for (const [key, value] of Object.entries(nodeRes.getHeaders())) {
    if (key.toLowerCase() === 'set-cookie' && value) {
      (Array.isArray(value) ? value : [String(value)]).forEach((v) => response.headers.append('set-cookie', v));
    }
  }
  return response;
}
