import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Marketing kit — share cards for AgentBook partners',
  description:
    'Ready-to-post social cards and copy that show the value of AgentBook. Download, add your referral link, and share.',
};

const CARDS = [
  { file: 'hours-back', title: 'Stop doing your books', blurb: 'Broad hook — the emotional payoff. Great cold-open post.' },
  { file: 'receipts', title: 'Snap the receipt', blurb: 'The “wait, it just does that?” demo moment.' },
  { file: 'get-paid', title: 'Get paid by card', blurb: 'For freelancers who chase invoices.' },
  { file: 'tax', title: 'Know your tax number', blurb: 'Lands hardest Jan–April and each quarter.' },
  { file: 'ai-bookkeeper', title: 'An AI bookkeeper you text', blurb: 'The one-liner that explains the whole product.' },
];

const CAPTIONS = [
  'I stopped doing my own books. AgentBook is an AI bookkeeper you just text — snap a receipt, send an invoice, and your taxes stay done in the background. It even warns you before cash or tax problems hit. Try it: [your link]',
  'Freelancers: your receipts can book themselves. Photo → AgentBook reads the amount, vendor and date → it’s in your books. No spreadsheet, no April scramble. [your link]',
  'The thing that finally made tax season boring (in a good way): AgentBook keeps a live tax estimate all year, so I always know what to set aside. Year-end is one export. [your link]',
];

export default function MaterialsPage() {
  return (
    <main>
      <div className="gd-eyebrow">Partner playbook</div>
      <h1 className="gd-h1">Marketing kit</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">Your goal</div>
        <p>Post something today. Grab a card, drop in your referral link, and share — no design work needed.</p>
      </div>
      <p className="gd-time">~2 min · download &amp; go</p>

      <h2 className="gd-h2">Share cards</h2>
      <p>
        Sized for social (1200×630). Click <strong>Download</strong>, then post it with one of the captions
        below and your referral link. Tip: to post as PNG, open the file and export — or screenshot it.
      </p>

      <div className="gd-kit">
        {CARDS.map((c) => (
          <div key={c.file} className="gd-kit-card">
            {/* eslint-disable-next-line @next/next/no-img-element -- static SVG share asset, not an optimizable content image */}
            <img src={`/guides/cards/${c.file}.svg`} alt={c.title} width={1200} height={630} loading="lazy" />
            <div className="gd-kit-meta">
              <b>{c.title}</b>
              <p>{c.blurb}</p>
              <a className="gd-dl" href={`/guides/cards/${c.file}.svg`} download>
                ↓ Download
              </a>
            </div>
          </div>
        ))}
      </div>

      <h2 className="gd-h2">Copy you can paste</h2>
      <p>Swap <code>[your link]</code> for your referral link (find it in Settings → Referrals):</p>
      {CAPTIONS.map((cap, i) => (
        <div key={i} className="gd-card">
          <p style={{ marginTop: 0 }}>{cap}</p>
        </div>
      ))}

      <h2 className="gd-h2">A few rules that keep it working</h2>
      <ol className="gd-steps">
        <li><b>Lead with the pain, not the product</b><span>“I stopped doing my books” beats “AgentBook has OCR.” People buy the outcome.</span></li>
        <li><b>Always show, don’t claim</b><span>A 10-second screen recording of snapping a receipt converts better than any card. Cards get the scroll to stop.</span></li>
        <li><b>Disclose the link</b><span>Say it’s a referral link — it’s required in most places and builds trust anyway.</span></li>
        <li><b>Point them to the right plan</b><span>Solo? Pro ($19/mo). Team or heavy volume? Business ($49/mo). There’s a Free tier to start.</span></li>
      </ol>

      <div className="gd-done">
        <span className="gd-check">✓</span>
        <div>Posted? See <Link href="/guides/sales-rep/earnings">what it earns</Link> and learn <Link href="/guides/sales-rep/how-it-works">how to explain it</Link>.</div>
      </div>

      <div className="gd-chips">
        <Link className="gd-chip" href="/guides/sales-rep">← Partner overview</Link>
        <Link className="gd-chip" href="/guides/sales-rep/how-it-works">How it works</Link>
        <Link className="gd-chip" href="/guides/sales-rep/earnings">Earnings &amp; math</Link>
      </div>

      <Link href="/guides" className="gd-back">&larr; All guides</Link>
    </main>
  );
}
