import Link from 'next/link';
import type { Metadata } from 'next';
import { Flow } from '../_components/Flow';

export const metadata: Metadata = {
  title: 'AgentBook for startup founders',
  description:
    'Set your startup’s finances up right in an afternoon — clean books from day one, burn & runway, invoicing, and tax (with startup benefits).',
};

export default function StartupFoundersGuide() {
  return (
    <main>
      <div className="gd-eyebrow">Founder guide</div>
      <h1 className="gd-h1">AgentBook for startup founders</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">Your goal</div>
        <p>
          Clean books from <strong>day one</strong> — so burn, runway, and tax are always answerable, and a
          fundraise or year-end never turns into a cleanup project.
        </p>
      </div>
      <p className="gd-time">~6 min · do it this afternoon</p>

      <p>
        Early-stage finance dies one of two ways: a shoebox of receipts nobody reconciles, or a bookkeeper you
        can’t afford yet. AgentBook is the third option — an AI that keeps the books, tracks burn, and flags
        tax as you go, from a chat box. Here’s the founder setup.
      </p>

      <h2 className="gd-h2">1 · Set the company up (10 minutes)</h2>
      <ol className="gd-steps">
        <li><b>Create the workspace</b><span>Sign up and run the onboarding wizard: country/jurisdiction, currency, fiscal year.</span></li>
        <li><b>Set business type to “Startup”</b><span>In <code>Settings → Business Profile</code>. This tailors your categories, tax guidance, and unlocks the <strong>Startup Tax Benefits</strong> tools.</span></li>
        <li><b>Seed your chart of accounts</b><span>Done for you on setup — revenue, the expense categories a startup actually uses, cash and equity.</span></li>
      </ol>

      <h2 className="gd-h2">2 · Track burn &amp; runway automatically</h2>
      <Flow
        caption="Connect the account once; spend books and reconciles itself."
        steps={[
          { label: 'Connect\nbank/card', sub: 'Plaid (US/CA)' },
          { label: 'Spend\nimports', sub: 'auto-categorized' },
          { label: 'Burn &\nrunway', sub: 'always current' },
          { label: 'Low-cash\nalert', sub: 'before it bites' },
        ]}
      />
      <p>
        Connect your business bank or card and every transaction flows in, categorized. Your monthly burn and
        cash position stay live — and the agent messages you when the cushion gets thin, instead of you finding
        out at month-end. Snap the occasional cash/paper receipt in Telegram and it’s booked the same way.
      </p>

      <h2 className="gd-h2">3 · Bill customers, get paid</h2>
      <p>
        Send branded invoices with a card “Pay now” button — money settles to your account and the invoice
        reconciles itself. Set up recurring invoices for retainers or subscriptions so revenue bills on
        autopilot. First revenue is a milestone; don’t let collecting it be manual.
      </p>

      <h2 className="gd-h2">4 · Tax — with startup benefits</h2>
      <Flow
        caption="A running estimate all year; startup-specific benefits surfaced for you."
        steps={[
          { label: 'Live tax\nestimate', sub: 'set-aside number' },
          { label: 'Startup\nbenefits', sub: 'credits & elections' },
          { label: 'Year-end\npackage', sub: 'ready to file' },
          { label: 'CPA\nreview', sub: 'share a link' },
        ]}
      />
      <p>
        AgentBook keeps a live tax estimate and, for startups, surfaces the benefits and elections worth asking
        your accountant about — so nothing’s left on the table. At year-end, generate the filing package and
        share a read-only review link with your CPA. It organizes the story; your accountant signs off on it.
      </p>
      <div className="gd-card">
        <b>Not tax or legal advice</b>
        <p>AgentBook surfaces and organizes — it doesn’t replace your accountant or attorney. Confirm entity-specific credits, elections and filings with a professional before you rely on them.</p>
      </div>

      <h2 className="gd-h2">5 · When you raise or hire</h2>
      <ol className="gd-steps">
        <li><b>Move to the Business plan</b><span>$49/mo unlocks unlimited volume and team seats when more than just you needs in.</span></li>
        <li><b>Give your accountant a seat</b><span>Invite your CPA/bookkeeper to review — no more emailing spreadsheets.</span></li>
        <li><b>Clean books = faster diligence</b><span>When an investor asks for numbers, they already exist and reconcile. That’s the whole point of starting on day one.</span></li>
      </ol>

      <h2 className="gd-h2">What it costs</h2>
      <table className="gd-table">
        <thead><tr><th>Plan</th><th>Price</th><th>Good for</th></tr></thead>
        <tbody>
          <tr><td><strong>Free</strong></td><td>$0</td><td>Pre-revenue — try it, book your first expenses.</td></tr>
          <tr><td><strong>Pro</strong></td><td>$19/mo</td><td>A solo founder: chat bot, tax exports, real quotas.</td></tr>
          <tr><td><strong>Business</strong></td><td>$49/mo</td><td>A team: unlimited everything, seats for co-founders/accountant.</td></tr>
        </tbody>
      </table>

      <div className="gd-done">
        <span className="gd-check">✓</span>
        <div>Set business type to <strong>Startup</strong>, connect your bank, and send your first invoice. Your books, burn and tax now keep themselves.</div>
      </div>

      <div className="gd-chips">
        <Link className="gd-chip" href="/guides">← All guides</Link>
        <Link className="gd-chip" href="/guides/workflows">Everyday workflows</Link>
        <Link className="gd-chip" href="/guides/chatbot-mcp">Chat &amp; Claude</Link>
      </div>

      <Link href="/guides" className="gd-back">&larr; All guides</Link>
    </main>
  );
}
