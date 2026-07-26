import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Earn as a partner — AgentBook Guides',
  description: 'Refer AgentBook and earn 20% — turn a tool you love into passive income.',
};

export default function SalesRepGuide() {
  return (
    <main>
      <div className="gd-eyebrow">Guide 04</div>
      <h1 className="gd-h1">Earn as an AgentBook partner</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">Your goal</div>
        <p>Turn a tool you already pay for into passive income &mdash; earn <strong>20%</strong> of every business you refer, for as long as they stay.</p>
      </div>
      <p className="gd-time">~3 min</p>

      <div className="gd-chips">
        <Link className="gd-chip" href="/guides/sales-rep/how-it-works">How AgentBook works →</Link>
        <Link className="gd-chip" href="/guides/sales-rep/materials">Marketing kit →</Link>
        <Link className="gd-chip" href="/guides/sales-rep/earnings">Earnings &amp; math →</Link>
      </div>

      <h2 className="gd-h2">Who can join</h2>
      <p>Any member on an <strong>active, paid annual plan</strong> can apply. (You’re vouching for a product you actually use — so the annual plan is the ticket in.)</p>

      <h2 className="gd-h2">How to become a rep</h2>
      <ol className="gd-steps">
        <li><b>Open the application</b><span>Go to <code>/sales-rep/apply</code> from your dashboard.</span></li>
        <li><b>Complete the 5-step signup</b><span>Fit → your country → benefits &amp; responsibilities → tax notice → review &amp; sign. It doubles as your partner agreement.</span></li>
        <li><b>Get approved</b><span>Our team reviews and emails you. (If it’s not a fit yet, you can re-apply after 90 days.)</span></li>
        <li><b>Set up payouts</b><span>Connect a Stripe account (a guided, hosted setup) so we can pay you directly. Tax forms — 1099-NEC in the US, T4A in Canada — are collected here.</span></li>
      </ol>

      <h2 className="gd-h2">What you earn</h2>
      <ol className="gd-steps">
        <li><b>20% commission, recurring</b><span>You earn 20% of what each referred customer pays — every quarter, for as long as their subscription stays active.</span></li>
        <li><b>Get your own plan back</b><span>Earn back your annual fee: if your commissions in the first 90 active days cover it, your annual fee is refunded (one time).</span></li>
        <li><b>Paid quarterly, to your account</b><span>Commissions land in your connected Stripe account on a quarterly schedule.</span></li>
      </ol>

      <h2 className="gd-h2">What the people you refer get</h2>
      <p>A tool that runs their books, taxes, and cash flow from a chat box — the same thing that won you over. You’re not selling them a discount; you’re handing them hours back every week.</p>

      <div className="gd-card">
        <b>Just want to refer a friend, not become a rep?</b>
        <p>Use your referral link in Settings — you get <strong>1 free month per paying friend</strong>, up to 12 months a year. No application needed.</p>
      </div>

      <div className="gd-done"><span className="gd-check">✓</span><div>Apply at <code>/sales-rep/apply</code>, sign, connect payouts, then share AgentBook. Every business that sticks pays you 20% — quarter after quarter.</div></div>

      <Link href="/guides" className="gd-back">&larr; All guides</Link>
    </main>
  );
}
