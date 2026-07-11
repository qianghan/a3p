import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { validateSession } from '@/lib/api/auth';
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
  const { uid } = await searchParams;
  if (!uid) redirect('/agentbook');

  const token = (await cookies()).get('naap_auth_token')?.value;
  const user = token ? await validateSession(token) : null;
  if (!user) {
    redirect(`/login?redirect=${encodeURIComponent(`/oauth-consent?uid=${uid}`)}`);
  }

  return <ConsentForm uid={uid} />;
}
