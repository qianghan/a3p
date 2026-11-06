import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Self-employed in Canada? How to catch up a full year of bookkeeping before Dec 31 — AgentBook Guides',
  description: 'Your 2026 bookkeeping lives in a shoebox? A 3-hour catch-up method, the 5 deductions Canadians miss most, and what to do before Dec 31.',
};

export default function YearEndBookkeepingCatchupGuide() {
  return (
    <main>
      <div className="gd-eyebrow">Guide 09</div>
      <h1 className="gd-h1">Self-employed in Canada? How to catch up a full year of bookkeeping before Dec 31</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">Your goal</div>
        <p>Turn a year of unfiled receipts into categorized books and a tax estimate — in one December afternoon.</p>
      </div>
      <p className="gd-time">~3 hours · for Canadian sole proprietors</p>

      <p>
        If you&rsquo;re self-employed in Canada and your 2026 bookkeeping currently lives in a
        shoebox, a spreadsheet tab you haven&rsquo;t opened since March, or &ldquo;I&rsquo;ll deal
        with it in April&rdquo; — this is the guide for December you.
      </p>

      <h2 className="gd-h2">Why December, not April</h2>
      <p>
        Two reasons. First, the CRA deadlines that matter to you land earlier than you
        think: GST/HST instalments, the RRSP contribution decision (deadline March 1,
        2027, but the cash has to exist in December), and any expense you want deducted
        in 2026 must be <i>paid</i> in 2026. Second, reconstructing 12 months of
        receipts in April is how deductions get missed. A freelancer who did this last
        year found $2,300 in missed home-office and software deductions — real money
        left on the table.
      </p>

      <h2 className="gd-h2">The 3-hour catch-up method</h2>
      <ol className="gd-steps">
        <li><b>Hour 1 — Collect</b><span>Every receipt into one folder: email confirmations (search &ldquo;receipt&rdquo;, &ldquo;invoice&rdquo;, &ldquo;payment confirmed&rdquo;), paper slips (photo them), app subscriptions (check your bank statement for the small recurring ones — those are the most-forgotten deductions).</span></li>
        <li><b>Hour 2 — Categorize</b><span>The CRA&rsquo;s T2125 wants your expenses in buckets: advertising, meals &amp; entertainment (50% only), office, supplies, professional fees, vehicle, home office. Sort once into these buckets and your tax return is halfway done. Mixed personal/business spending goes through the &ldquo;business-use %&rdquo; test — document the percentage now, not in April.</span></li>
        <li><b>Hour 3 — Estimate</b><span>Rough P&amp;L: total income minus categorized expenses. Then a back-of-envelope tax owing estimate. The goal isn&rsquo;t precision — it&rsquo;s eliminating the April surprise.</span></li>
      </ol>

      <h2 className="gd-h2">The 5 deductions Canadians miss most</h2>
      <ol className="gd-steps">
        <li><b>Home office</b><span>Not just rent %: utilities, insurance, maintenance, mortgage interest (not principal).</span></li>
        <li><b>Phone / internet business %</b><span>Documented, consistent.</span></li>
        <li><b>Software &amp; subscriptions</b><span>The $12/mo tools add up to real deductions.</span></li>
        <li><b>Professional development</b><span>Courses, books, conferences tied to your work.</span></li>
        <li><b>Vehicle</b><span>Mileage log beats gas receipts; start it now.</span></li>
      </ol>

      <div className="gd-say">
        <div className="gd-say-k">Want it done with you?</div>
        <p>
          We&rsquo;re running a free 3-week <b>Year-End Books Rescue</b> for 15 self-employed
          Canadians: forward your 2026 receipts, get weekly P&amp;L snapshots + a year-end
          tax estimate + your missed-deduction report, all through an AI bookkeeping
          chat. Free, no card. <Link href="/register">Create a free account to join</Link>.
        </p>
      </div>

      <p className="gd-note">
        General information only, not tax advice. For complex situations, talk to a CPA.
      </p>

      <Link href="/guides" className="gd-back">&larr; All guides</Link>
    </main>
  );
}
