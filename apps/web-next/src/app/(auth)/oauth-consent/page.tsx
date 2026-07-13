import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { validateSession } from '@/lib/api/auth';
import { isMcpEnabled } from '@/lib/mcp/mcp-flag';
import { ConsentForm } from './consent-form';

// Server-side login gate only — the interaction details themselves (client
// id, whether consent was already granted) are fetched client-side by
// `ConsentForm` via the `/api/v1/oauth/interaction` route handler, which is
// the only place that has a real `NextRequest` to hand oidc-provider for its
// interaction-cookie lookup (see that route's comment).
export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ uid?: string }>;
}) {
  // Kill switch: with the flag off, a user shouldn't be able to reach a
  // working consent screen at all — the API routes it depends on
  // (`/api/v1/oauth/interaction`, `/api/v1/oauth/consent-decision`) are
  // gated the same way, so rendering the form here would just dead-end into
  // 503s. Bail out before doing any other work (including the auth check
  // below) so a disabled deployment doesn't leak anything beyond "this
  // isn't available".
  if (!(await isMcpEnabled())) redirect('/agentbook');

  const { uid } = await searchParams;
  if (!uid) redirect('/agentbook');

  const token = (await cookies()).get('naap_auth_token')?.value;
  const user = token ? await validateSession(token) : null;
  if (!user) {
    redirect(`/login?redirect=${encodeURIComponent(`/oauth-consent?uid=${uid}`)}`);
  }

  return <ConsentForm uid={uid} />;
}
