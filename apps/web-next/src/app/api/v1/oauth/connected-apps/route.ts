import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { validateSession } from '@/lib/api/auth';
import { prisma, PrismaOidcAdapter } from '@naap/database';

export interface ConnectedAppSummary {
  clientId: string;
  clientName: string;
  scope: string;
  grantedAt: string;
}

export async function GET(): Promise<NextResponse> {
  const token = (await cookies()).get('naap_auth_token')?.value;
  const user = token ? await validateSession(token) : null;
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const grants = await prisma.mcpConsentGrant.findMany({
    where: { userId: user.id, revokedAt: null },
    orderBy: { grantedAt: 'desc' },
  });

  // Best-effort friendly name lookup: Dynamic Client Registration (RFC 7591)
  // stores client metadata under `type: 'Client'` in OidcModel, keyed by the
  // registered client_id, with metadata field names preserved as registered
  // (snake_case per the RFC — verified against
  // node_modules/oidc-provider/lib/consts/client_attributes.js, which lists
  // `client_name` verbatim, unlike the internal Grant model's own camelCase
  // `accountId`/`clientId` fields). Falls back to the raw clientId if the
  // client row is gone or never set a name.
  const clientRows = await prisma.oidcModel.findMany({
    where: { type: 'Client', id: { in: grants.map((g) => g.clientId) } },
  });
  const clientNames = new Map<string, string>(
    clientRows.map((row) => {
      const payload = row.payload as { client_name?: string };
      return [row.id, payload.client_name || row.id];
    }),
  );

  const data: ConnectedAppSummary[] = grants.map((g) => ({
    clientId: g.clientId,
    clientName: clientNames.get(g.clientId) || g.clientId,
    scope: g.scope,
    grantedAt: g.grantedAt.toISOString(),
  }));

  return NextResponse.json({ data });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const token = (await cookies()).get('naap_auth_token')?.value;
  const user = token ? await validateSession(token) : null;
  if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const { clientId } = await request.json();
  if (!clientId || typeof clientId !== 'string') {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const grant = await prisma.mcpConsentGrant.findUnique({
    where: { userId_clientId: { userId: user.id, clientId } },
  });
  if (!grant) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Real, immediate revocation of already-issued tokens MUST happen BEFORE we
  // mark our own consent record revoked (see catch block below for why the
  // ordering matters). oidc-provider's own Grant model persists
  // `accountId`/`clientId` verbatim in its payload (verified against
  // node_modules/oidc-provider/lib/models/grant.js IN_PAYLOAD: camelCase, not
  // the RFC's snake_case) but does NOT store its own `grantId` in that
  // payload -- only the five grant-bound consumable models (AccessToken,
  // RefreshToken, AuthorizationCode, DeviceCode,
  // BackchannelAuthenticationRequest -- see
  // node_modules/oidc-provider/lib/models/mixins/has_grant_id.js) carry a
  // `grantId` field, which PrismaOidcAdapter.upsert promotes to the
  // `OidcModel.grantId` indexed column. So: find the user's Grant row(s) for
  // this client by JSON path match on the Grant's own payload, then for each
  // one (a) sweep every grant-bound token row via revokeByGrantId (mirrors
  // oidc-provider's own internal lib/helpers/revoke.js, which calls
  // `model.revokeByGrantId(grantId)` for each of those five models -- the
  // Prisma adapter's implementation collapses that into a single
  // `deleteMany({ where: { grantId } })` since it isn't scoped by `type`) and
  // (b) separately destroy the Grant's own OidcModel row (revokeByGrantId
  // does not touch it, since the Grant's own payload has no grantId field of
  // its own) -- otherwise a later reconnect's `provider.Grant.find(grantId)`
  // would still resolve and the "revoked" grant would silently be treated as
  // still-valid consent.
  const oidcGrants = await prisma.oidcModel.findMany({
    where: {
      type: 'Grant',
      AND: [
        { payload: { path: ['accountId'], equals: user.id } },
        { payload: { path: ['clientId'], equals: clientId } },
      ],
    },
  });

  const grantAdapter = new PrismaOidcAdapter('Grant');
  try {
    await Promise.all(
      oidcGrants.flatMap((g) => [
        grantAdapter.revokeByGrantId(g.id),
        grantAdapter.destroy(g.id),
      ]),
    );
  } catch (err) {
    // Token destruction failed partway through (PrismaOidcAdapter has no
    // shared-transaction hook we can wrap this and the mcpConsentGrant update
    // in together -- it's hardwired to the module-level `prisma` singleton,
    // not an injectable client). Leaving the consent record unmarked here is
    // deliberate: if we'd already flipped `revokedAt` before this step (as
    // the original implementation did), a failure here would leave the UI
    // showing "revoked" while the underlying bearer/refresh tokens for this
    // grant are still live until their natural TTL -- exactly the gap this
    // feature exists to close. Returning an error (not {success:true}) lets
    // the caller retry, which is safe: revokeByGrantId/destroy are idempotent
    // against already-deleted rows.
    console.error('connected-apps DELETE: token revocation failed', err);
    return NextResponse.json({ error: 'revocation_failed' }, { status: 500 });
  }

  // Only now that outstanding tokens are confirmed destroyed do we mark our
  // own durable consent record revoked. This is the "has the user consented"
  // record the /consent-decision and /authorize flows check on future
  // connection attempts.
  await prisma.mcpConsentGrant.update({
    where: { id: grant.id },
    data: { revokedAt: new Date() },
  });

  return NextResponse.json({ success: true });
}
