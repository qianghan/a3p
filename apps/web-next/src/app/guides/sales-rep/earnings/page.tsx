import Link from 'next/link';
import type { Metadata } from 'next';
import { EarningsCalculator } from '../../_components/EarningsCalculator';

export const metadata: Metadata = {
  title: 'What you earn as an AgentBook partner',
  description:
    'The real numbers behind AgentBook’s 20% recurring commission — how passive income compounds, with a live calculator.',
};

export default function EarningsGuide() {
  return (
    <main>
      <div className="gd-eyebrow">Partner playbook</div>
      <h1 className="gd-h1">What you can actually earn</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">Your goal</div>
        <p>
          Understand why referring AgentBook is <strong>passive income</strong>, not a one-time bounty — and
          run your own numbers below.
        </p>
      </div>
      <p className="gd-time">~4 min · real numbers, no hype</p>

      <h2 className="gd-h2">The model in one line</h2>
      <p>
        You earn <strong>20% of what every customer you refer pays</strong> — every billing cycle, for as long
        as they stay subscribed. It’s recurring, so referrals stack: last quarter’s referrals keep paying while
        you add new ones.
      </p>

      <h2 className="gd-h2">The actual prices you’re earning on</h2>
      <table className="gd-table">
        <thead>
          <tr><th>Plan</th><th>Customer pays</th><th>You earn (20%)</th><th>Per year</th></tr>
        </thead>
        <tbody>
          <tr><td><strong>Pro</strong></td><td>$19 / mo</td><td>$3.80 / mo</td><td><strong>$45.60</strong></td></tr>
          <tr><td><strong>Business</strong></td><td>$49 / mo</td><td>$9.80 / mo</td><td><strong>$117.60</strong></td></tr>
        </tbody>
      </table>
      <p className="gd-note">Free-plan users pay nothing, so there’s no commission until they upgrade — your job is helping people who’ll get real value, who then happily pay.</p>

      <h2 className="gd-h2">Run your numbers</h2>
      <p>Drag the sliders. This uses AgentBook’s real plan prices and the 20% rate:</p>
      <EarningsCalculator />

      <h2 className="gd-h2">Why it compounds</h2>
      <ol className="gd-steps">
        <li><b>It’s recurring, not one-and-done</b><span>A customer you refer in Q1 is still paying you in Q4 — and next year. New referrals add on top.</span></li>
        <li><b>You get your own plan back</b><span>If your commissions in your first 90 active days cover your annual fee, that fee is refunded (one time). The tool effectively pays for itself.</span></li>
        <li><b>Paid quarterly, straight to your account</b><span>Commissions land in your connected Stripe account every quarter — no invoicing us, no chasing.</span></li>
        <li><b>You’re recommending what you already use</b><span>The credibility is free. You’re not cold-selling; you’re showing people the tool that saved you hours.</span></li>
      </ol>

      <div className="gd-card">
        <b>Realistic, not get-rich-quick</b>
        <p>
          These are gross commissions before your own taxes, and they assume customers stay subscribed
          (some won’t). Treat it as a durable side-income that grows with your network — not a lottery ticket.
        </p>
      </div>

      <h2 className="gd-h2">How you get paid</h2>
      <ol className="gd-steps">
        <li><b>Be on an active annual plan</b><span>That’s the ticket in — you’re vouching for a product you actually pay for and use.</span></li>
        <li><b>Apply &amp; sign</b><span>The 5-step application at <code>/sales-rep/apply</code> doubles as your partner agreement, where your exact rate and terms are set.</span></li>
        <li><b>Connect payouts</b><span>A guided Stripe setup collects your tax form (1099-NEC in the US, T4A in Canada) and your bank details.</span></li>
        <li><b>Share &amp; earn</b><span>Use your link. Every business that sticks pays you 20%, quarter after quarter.</span></li>
      </ol>

      <div className="gd-done">
        <span className="gd-check">✓</span>
        <div>Ready? Learn the pitch in <Link href="/guides/sales-rep/how-it-works">How it works</Link>, grab <Link href="/guides/sales-rep/materials">share cards</Link>, then apply at <code>/sales-rep/apply</code>.</div>
      </div>

      <div className="gd-chips">
        <Link className="gd-chip" href="/guides/sales-rep">← Partner overview</Link>
        <Link className="gd-chip" href="/guides/sales-rep/how-it-works">How it works</Link>
        <Link className="gd-chip" href="/guides/sales-rep/materials">Marketing kit</Link>
      </div>

      <Link href="/guides" className="gd-back">&larr; All guides</Link>
    </main>
  );
}
