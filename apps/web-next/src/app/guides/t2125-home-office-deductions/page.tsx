import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'T2125 home office expenses 2026 — the deductions Canadian freelancers miss most — AgentBook Guides',
  description: 'Detailed vs simplified method, what counts, the 3 mistakes that trigger CRA attention, and a December action list for your T2125.',
};

export default function T2125HomeOfficeGuide() {
  return (
    <main>
      <div className="gd-eyebrow">Guide 10</div>
      <h1 className="gd-h1">T2125 home office expenses 2026 — the deductions Canadian freelancers miss most</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">Your goal</div>
        <p>Claim every home-office dollar you&rsquo;re entitled to — and none you&rsquo;re not.</p>
      </div>
      <p className="gd-time">~10 min read · for Canadian sole proprietors filing a T2125</p>

      <p>
        If you file a T2125 (Statement of Business or Professional Activities) as a
        Canadian sole proprietor, the home-office line is where the most money gets
        missed — and where the CRA looks closest. Here&rsquo;s how to get it right for 2026.
      </p>

      <h2 className="gd-h2">The two methods (and which one to pick)</h2>
      <div className="gd-card">
        <b>Detailed method</b>
        <p>Claim the business-use % of <i>all</i> eligible home expenses. More paperwork, bigger deduction. Worth it if you work from home most days.</p>
      </div>
      <div className="gd-card">
        <b>Simplified method</b>
        <p>Flat rate per workday (the CRA set temporary flat rates during COVID; for 2026 the detailed method is the standard path — check current CRA guidance for any flat-rate option).</p>
      </div>
      <p>
        Rule of thumb: if your home office is used &gt;50% for work and you work from home
        4+ days a week, run the numbers on the detailed method. It usually wins by 2–4x.
      </p>

      <h2 className="gd-h2">What counts (detailed method)</h2>
      <ol className="gd-steps">
        <li><b>Rent, or mortgage interest (not principal), property tax, home insurance</b><span>The big fixed costs, prorated by business-use %.</span></li>
        <li><b>Utilities: heat, electricity, water</b><span>Same proration — keep the bills.</span></li>
        <li><b>Maintenance and minor repairs</b><span>That leaky faucet you fixed in the office corner — prorated.</span></li>
        <li><b>Internet and phone</b><span>Business-use %.</span></li>
      </ol>

      <h2 className="gd-h2">The 3 mistakes that trigger CRA attention</h2>
      <ol className="gd-steps">
        <li><b>Claiming 100% of the home</b><span>The business-use % must be measured (office sq ft ÷ home sq ft) and reasonable. 10–20% is typical.</span></li>
        <li><b>No documentation</b><span>Keep the floor-plan math and bills for 6 years.</span></li>
        <li><b>Claiming a loss to create a refund</b><span>Home-office expenses can&rsquo;t create or increase a business loss on the T2125 (they&rsquo;re capped at business income, excess carries forward).</span></li>
      </ol>

      <h2 className="gd-h2">A December action list</h2>
      <p>
        Measure your workspace this week (photo the tape measure — future-you says
        thanks). Pull 12 months of utility / rent / mortgage-interest numbers. Decide
        detailed vs simplified <i>before</i> year-end, because it changes which receipts
        you need.
      </p>

      <div className="gd-say">
        <div className="gd-say-k">Doing this math by hand for a whole year?</div>
        <p>
          Our free 3-week <b>Year-End Books Rescue</b> (15 spots) includes a home-office
          calculation done for you. <Link href="/register">Create a free account to join</Link>.
        </p>
      </div>

      <p className="gd-note">
        General information only, not tax advice.
      </p>

      <Link href="/guides" className="gd-back">&larr; All guides</Link>
    </main>
  );
}
