import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'How AgentBook collects, uses, and protects your data.',
};

export default function PrivacyPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-12 prose prose-sm prose-zinc dark:prose-invert">
      <h1>Privacy Policy</h1>
      <p className="text-sm text-muted-foreground">Last updated: 2026-07-17</p>

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
        <li>
          <strong>Supabase</strong> — primary database. All financial records,
          account information, and agent-conversation history are stored
          here.
        </li>
      </ul>

      <h2>4. Regional privacy rights</h2>
      <p>
        Depending on where you live, additional laws may apply to how we
        handle your data — for example, the Personal Information Protection
        and Electronic Documents Act (PIPEDA) in Canada, and the Privacy Act
        1988 in Australia. The rights described in the next section (export,
        deletion, and disconnecting a connected service) are available to
        every AgentBook user regardless of jurisdiction, and are intended to
        satisfy the access and deletion rights those laws provide.
      </p>

      <h2>5. Your rights</h2>
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

      <h2>6. Retention</h2>
      <p>
        Active accounts retain data indefinitely so you can return to prior
        years for tax purposes. Deleted accounts have all rows hard-removed
        after 30 days. Anonymized aggregate metrics may persist for service
        reliability.
      </p>

      <h2>7. Security</h2>
      <p>
        Plaid and Stripe tokens are encrypted at rest (AES-256-GCM). All
        traffic is TLS-only. Tenant data is isolated at the database level —
        every row carries a tenant ID and queries are scoped to the
        authenticated tenant. Admin-only operations require an allowlisted
        email plus a server-side shared secret.
      </p>

      <h2>8. Children's privacy</h2>
      <p>
        AgentBook is not directed to, and is not intended for use by, anyone
        under the age of 18. We do not knowingly collect personal information
        from anyone under 18. If you believe a child has provided us with
        personal information, contact us at the address below and we will
        delete it.
      </p>

      <h2>9. Contact</h2>
      <p>
        Email <a href="mailto:privacy@agentbook.io">privacy@agentbook.io</a>{' '}
        for any privacy question or to request a deletion outside the
        self-serve endpoint.
      </p>
    </main>
  );
}
