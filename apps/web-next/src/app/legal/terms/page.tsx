import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'AgentBook terms of service.',
};

export default function TermsPage() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-12 prose prose-sm prose-zinc dark:prose-invert">
      <h1>Terms of Service</h1>
      <p className="text-sm text-muted-foreground">Last updated: 2026-07-17</p>

      <h2>1. The service</h2>
      <p>
        AgentBook is an AI-powered bookkeeping assistant. The agent classifies
        expenses, drafts invoices, estimates tax liability, and answers
        questions about your books. The agent is a software tool and is not a
        licensed CPA, tax advisor, or attorney. You remain responsible for the
        accuracy of your filings and for any decisions you make based on its
        output.
      </p>

      <h2>2. Account</h2>
      <p>
        You are responsible for keeping your login credentials secure. You may
        not use the service in violation of any applicable law, or to process
        data on behalf of third parties without their consent. You must be at
        least 18 years old, or the age of majority in your jurisdiction if
        that is older than 18, to create an account or use AgentBook. By
        registering, you represent that you meet this requirement.
      </p>

      <h2>3. Subscriptions and billing</h2>
      <p>
        Paid plans are billed monthly or annually through Stripe. Plans renew
        automatically at the end of each period. You can cancel at any time
        from Settings; access continues until the end of the paid period and
        no refund is issued for the remainder. Past-due accounts may be
        suspended after a 7-day grace window.
      </p>
      <p>
        Add-on subscriptions are billed in advance. Student Success, Tax
        Fast-Track, and Startup Tax Benefits are billed annually; Personal
        Insights is billed monthly. The same no-refund policy applies:
        canceling an add-on stops the next renewal, but access continues for
        the remainder of the period you already paid for, and no partial-period
        refund is issued.
      </p>

      <h2>4. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Reverse-engineer, resell, or sub-license the service.</li>
        <li>Upload content you do not have the right to process.</li>
        <li>Attempt to access another tenant's data.</li>
        <li>
          Use automated tools to scrape the application beyond rate limits
          documented in the API surface.
        </li>
      </ul>

      <h2>5. Disclaimer of warranties</h2>
      <p>
        AgentBook is provided "as is." We do not warrant that the service will
        be uninterrupted, error-free, or that the agent's classifications are
        free of mistakes. Always review machine-generated entries before
        committing them to a filing.
      </p>

      <h2>6. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, AgentBook is not liable for
        indirect, incidental, or consequential damages, or for any lost
        profits or lost data. Aggregate liability is limited to the amount you
        paid in the twelve months preceding the claim.
      </p>

      <h2>7. Termination</h2>
      <p>
        Either party may terminate at any time. On termination you may export
        your data (<code>GET /api/v1/agentbook/me/export</code>) and request
        deletion (<code>DELETE /api/v1/agentbook/me</code>).
      </p>

      <h2>8. Changes</h2>
      <p>
        We may update these terms. Material changes will be announced in-app.
        Continued use after the effective date constitutes acceptance.
      </p>

      <h2>9. Contact</h2>
      <p>
        Email <a href="mailto:support@agentbook.io">support@agentbook.io</a>{' '}
        for any question about these terms.
      </p>
    </main>
  );
}
