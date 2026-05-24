import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'How AgentBook collects, uses, and protects your data.',
};

export default function PrivacyPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-12 prose prose-sm prose-zinc dark:prose-invert">
      <h1>Privacy Policy</h1>
      <p className="text-sm text-muted-foreground">Last updated: 2026-05-24</p>

      <h2>1. What we collect</h2>
      <p>
        AgentBook is an AI-powered bookkeeping product. To run your books we
        collect:
      </p>
      <ul>
        <li>Account information you provide: email, name, business profile.</li>
        <li>
          Financial data you import or enter: expenses, invoices, vendor and
          client names, receipt images, bank-transaction history pulled via
          Plaid.
        </li>
        <li>
          Agent-conversation transcripts (web chat and Telegram) so the agent
          can recall context across sessions.
        </li>
        <li>
          Service-level logs (request timestamps, error stack traces) for
          reliability. These do not contain financial line items.
        </li>
      </ul>

      <h2>2. How we use it</h2>
      <p>
        We use your data only to operate AgentBook for you: classifying
        expenses, generating tax estimates, drafting invoices, surfacing
        proactive alerts, and improving the agent's accuracy on your account.
        We do not sell your data and do not share it with advertisers.
      </p>

      <h2>3. Third-party processors</h2>
      <ul>
        <li>
          <strong>Plaid</strong> — bank-account connection. Access tokens are
          encrypted at rest with AES-256-GCM before being stored.
        </li>
        <li>
          <strong>Stripe</strong> — payment processing. Card data never touches
          our servers; we store only customer / subscription IDs.
        </li>
        <li>
          <strong>Telegram</strong> — bot delivery, if you connect Telegram.
        </li>
        <li>
          <strong>Google (Gemini)</strong> — LLM inference. Conversation
          excerpts are sent for classification; we do not opt into training
          data sharing.
        </li>
        <li>
          <strong>Vercel</strong> — application hosting and edge delivery.
        </li>
      </ul>

      <h2>4. Your rights</h2>
      <p>You can at any time:</p>
      <ul>
        <li>
          <strong>Export</strong> all your data as JSON via{' '}
          <code>GET /api/v1/agentbook/me/export</code>.
        </li>
        <li>
          <strong>Delete</strong> your account and all associated data via{' '}
          <code>DELETE /api/v1/agentbook/me</code>. Hard delete is final after
          a 30-day grace window.
        </li>
        <li>Disconnect Plaid, Telegram, or Stripe individually from Settings.</li>
      </ul>

      <h2>5. Retention</h2>
      <p>
        Active accounts retain data indefinitely so you can return to prior
        years for tax purposes. Deleted accounts have all rows hard-removed
        after 30 days. Anonymized aggregate metrics may persist for service
        reliability.
      </p>

      <h2>6. Security</h2>
      <p>
        Plaid and Stripe tokens are encrypted at rest (AES-256-GCM). All
        traffic is TLS-only. Tenant data is isolated at the database level —
        every row carries a tenant ID and queries are scoped to the
        authenticated tenant. Admin-only operations require an allowlisted
        email plus a server-side shared secret.
      </p>

      <h2>7. Contact</h2>
      <p>
        Email <a href="mailto:privacy@agentbook.io">privacy@agentbook.io</a>{' '}
        for any privacy question or to request a deletion outside the
        self-serve endpoint.
      </p>
    </main>
  );
}
