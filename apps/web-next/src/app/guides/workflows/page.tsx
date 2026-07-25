import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Everyday workflows — AgentBook Guides',
  description: 'The three you’ll use most: bookkeeping, tax filing, and personal finance.',
};

export default function WorkflowsGuide() {
  return (
    <main>
      <div className="gd-eyebrow">Guide 02</div>
      <h1 className="gd-h1">Your everyday workflows</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">Your goal</div>
        <p>Keep clean books, see what you’ll owe, and know where your money stands &mdash; without spreadsheets.</p>
      </div>
      <p className="gd-time">~3 min</p>

      <h2 className="gd-h2">1 · Bookkeeping (do this daily)</h2>
      <ol className="gd-steps">
        <li><b>Capture the expense</b><span>Snap a receipt at <code>/agentbook/receipts</code>, or just tell the chat “$42 gas, business”. AgentBook categorizes it.</span></li>
        <li><b>Let the bank do the typing</b><span>Connect an account at <code>/agentbook/bank</code> so transactions import automatically. (Bank sync is on paid plans.)</span></li>
        <li><b>Clear the review queue</b><span>Check <code>/agentbook/expenses</code> now and then — confirm anything flagged, split personal from business.</span></li>
      </ol>

      <h2 className="gd-h2">2 · Tax filing (no surprises)</h2>
      <ol className="gd-steps">
        <li><b>Watch your estimate</b><span>Open the Tax dashboard at <code>/agentbook/tax</code> for a live estimate of what you’ll owe and quarterly amounts.</span></li>
        <li><b>Generate your package</b><span>At <code>/agentbook/tax-package</code>, build a filing-ready PDF + CSVs (P&amp;L, deductions, mileage).</span></li>
        <li><b>File it</b><span>AgentBook <strong>prepares</strong> everything; you (or your accountant) file it with the IRS / CRA / ATO. It isn’t lodged automatically.</span></li>
      </ol>

      <h2 className="gd-h2">3 · Personal finance (the whole picture)</h2>
      <ol className="gd-steps">
        <li><b>Open your money view</b><span>Go to <code>/personal</code> for net worth, savings rate, and trends.</span></li>
        <li><b>Connect personal accounts</b><span>Link a bank so balances and spending update on their own.</span></li>
        <li><b>Ask for a read</b><span>In chat: “how’s my savings rate?” or “am I on track this month?”.</span></li>
      </ol>

      <div className="gd-done"><span className="gd-check">✓</span><div>Snap receipts as you go, glance at the tax estimate weekly, and check <code>/personal</code> monthly. That’s the whole rhythm.</div></div>

      <Link href="/guides" className="gd-back">&larr; All guides</Link>
    </main>
  );
}
