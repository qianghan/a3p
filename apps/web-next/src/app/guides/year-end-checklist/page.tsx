import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Year-end checklist for self-employed Canadians — AgentBook Guides',
  description: '15 checks to close your 2026 books before Dec 31: receipts, deductions, GST/HST, RRSP, and the three habits to keep in 2027.',
};

export default function YearEndChecklistGuide() {
  return (
    <main>
      <div className="gd-eyebrow">Guide 08</div>
      <h1 className="gd-h1">The 15-item year-end checklist</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">Your goal</div>
        <p>Close your 2026 books before Dec 31 — every receipt found, every deduction claimed, no April surprise.</p>
      </div>
      <p className="gd-time">~15 min to work through · for Canadian sole proprietors</p>

      <p>
        If you are self-employed in Canada, December is when the year&rsquo;s bookkeeping
        either gets done or gets expensive. Work through these 15 items in order —
        receipts first, then the deductions people miss most, then the tax moves
        that only work before Dec 31.
      </p>

      <h2 className="gd-h2">Receipts &amp; books</h2>
      <ol className="gd-steps">
        <li><b>Gather every 2026 receipt</b><span>Email confirmations, paper slips, app-store invoices — one folder, no exceptions.</span></li>
        <li><b>Reconcile bank + credit-card statements</b><span>Against your records; flag anything uncategorized.</span></li>
        <li><b>Split personal vs business on mixed-use cards</b><span>The CRA&rsquo;s #1 audit trigger for sole proprietors.</span></li>
        <li><b>Log vehicle mileage now</b><span>While you still remember — reconstructing in April never works.</span></li>
      </ol>

      <h2 className="gd-h2">Deductions — the ones people miss</h2>
      <ol className="gd-steps" start={5}>
        <li><b>Home office</b><span>Measure the workspace % and collect rent / mortgage interest, utilities, insurance, maintenance.</span></li>
        <li><b>Phone + internet</b><span>Business-use % documented.</span></li>
        <li><b>Professional dues &amp; subscriptions</b><span>Software, domains, hosting renewals.</span></li>
        <li><b>Business meals &amp; travel</b><span>Who, why, receipt — all three or it doesn&rsquo;t count.</span></li>
        <li><b>Asset purchases over ~$500</b><span>Check CCA classes instead of expensing outright.</span></li>
      </ol>

      <h2 className="gd-h2">Tax moves — before Dec 31</h2>
      <ol className="gd-steps" start={10}>
        <li><b>Estimate 2026 net self-employment income</b><span>Rough tax owing, now — avoid the April surprise.</span></li>
        <li><b>If GST/HST registrant</b><span>Confirm the Q4 filing deadline and set the cash aside now.</span></li>
        <li><b>RRSP room check</b><span>The contribution deadline is March 1, 2027, but the decision is a December one.</span></li>
        <li><b>Pay planned early-2027 business expenses now</b><span>To deduct them in 2026.</span></li>
      </ol>

      <h2 className="gd-h2">Wrap-up</h2>
      <ol className="gd-steps" start={14}>
        <li><b>Export a 2026 P&amp;L — even a rough one</b><span>You can&rsquo;t plan 2027 taxes without it.</span></li>
        <li><b>Write down the 3 bookkeeping habits you&rsquo;ll keep monthly in 2027</b><span>The whole point of this list.</span></li>
      </ol>

      <p className="gd-note">
        General information only, not tax advice. For your situation, talk to a CPA.
      </p>

      <div className="gd-say">
        <div className="gd-say-k">Still stuck after all 15?</div>
        <p>
          We&rsquo;re running a free 3-week <b>Year-End Books Rescue</b> for 15 self-employed
          Canadians: send us your receipts and we&rsquo;ll sort them into books for you in
          AgentBook chat. Free, no card. <Link href="/register">Create a free account to join</Link>.
        </p>
      </div>

      <div className="gd-done"><span className="gd-check">✓</span><div>Done — your 2026 books are closed, your deductions are claimed, and 2027 starts clean.</div></div>

      <Link href="/guides" className="gd-back">&larr; All guides</Link>
    </main>
  );
}
