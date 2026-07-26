import Link from 'next/link';
import type { Metadata } from 'next';
import { Flow } from '../../_components/Flow';

export const metadata: Metadata = {
  title: 'How AgentBook works — a rep’s field guide',
  description:
    'The four value workflows that win people over — expenses, invoicing, tax, and the proactive agent — with diagrams and exactly what to say.',
};

export default function HowItWorksGuide() {
  return (
    <main>
      <div className="gd-eyebrow">Partner playbook</div>
      <h1 className="gd-h1">How AgentBook works — and how to explain it</h1>
      <div className="gd-goal">
        <div className="gd-goal-k">Your goal</div>
        <p>
          Be able to explain AgentBook in 60 seconds. Four workflows do 90% of the selling — learn the
          diagram and the one line that lands for each.
        </p>
      </div>
      <p className="gd-time">~5 min · your pitch cheat-sheet</p>

      <p>
        AgentBook isn’t “accounting software.” It’s a financial agent that runs someone’s books from a chat
        box. The pitch isn’t features — it’s <strong>hours back every week</strong> and <strong>never being
        surprised by tax</strong>. Here are the four moments that make people say “wait, it just does that?”
      </p>

      <h2 className="gd-h2">1 · Snap a receipt, it’s booked</h2>
      <Flow
        caption="Photo → AI reads it → categorized → in the books. No forms."
        steps={[
          { label: 'Snap or\nforward', sub: 'photo / PDF' },
          { label: 'AI reads it', sub: 'amount · vendor · date' },
          { label: 'Auto-\ncategorized', sub: 'right account' },
          { label: 'In the\nbooks', sub: 'journal entry' },
        ]}
      />
      <p>
        Your customer photographs a receipt in Telegram (or the app). AgentBook’s vision model pulls the
        amount, vendor and date, files it to the right category, and writes the bookkeeping entry — in
        seconds. No spreadsheet, no data entry, no shoebox in April.
      </p>
      <div className="gd-say">
        <div className="gd-say-k">Say this</div>
        <p>“You know that pile of receipts? Take a photo. It’s booked before you put your phone down.”</p>
      </div>

      <h2 className="gd-h2">2 · Send an invoice, get paid by card</h2>
      <Flow
        caption="Create → send → client taps Pay → cash + books update themselves."
        steps={[
          { label: 'Create\ninvoice', sub: 'or recurring' },
          { label: 'Send', sub: 'email + link' },
          { label: 'Client pays\nby card', sub: 'straight to them' },
          { label: 'Marked paid', sub: 'books updated' },
        ]}
      />
      <p>
        Invoices go out with a “Pay now” button. The client pays by card, the money lands in{' '}
        <strong>your customer’s</strong> own account (not ours), and the invoice marks itself paid with the
        cash entry booked automatically. Recurring clients can be billed on autopilot.
      </p>
      <div className="gd-say">
        <div className="gd-say-k">Say this</div>
        <p>“You get paid faster because clients can just tap a card — and you never touch a bookkeeping entry.”</p>
      </div>

      <h2 className="gd-h2">3 · Tax that’s never a surprise</h2>
      <Flow
        caption="Every transaction feeds a live estimate; year-end is one export."
        steps={[
          { label: 'Every txn', sub: 'income + expense' },
          { label: 'Live tax\nestimate', sub: 'set-aside number' },
          { label: 'Year-end\npackage', sub: 'Schedule C / T2125' },
          { label: 'CPA\nreview', sub: 'share a link' },
        ]}
      />
      <p>
        AgentBook keeps a running tax estimate all year — US, Canada and Australia rules built in — so your
        customer always knows what to set aside. At year-end it generates the filing package (Schedule C,
        T2125, and the rest) and hands their accountant a read-only review link. No scramble.
      </p>
      <div className="gd-say">
        <div className="gd-say-k">Say this</div>
        <p>“It tells you what to set aside for tax today — so April is a non-event, not a heart attack.”</p>
      </div>

      <h2 className="gd-h2">4 · A financial agent that speaks first</h2>
      <Flow
        highlightLast
        caption="It watches the money and warns you before it’s a problem."
        steps={[
          { label: 'Agent\nwatches', sub: 'cash · tax · spend' },
          { label: 'Spots a\nrisk', sub: 'cliff / spike / gap' },
          { label: 'Messages\nyou first', sub: 'before you ask' },
        ]}
      />
      <p>
        This is the part competitors don’t have. AgentBook proactively flags a thin cash cushion, a tax bill
        forming, a spending spike, missing receipts, or an unpaid invoice — in chat, before you’d think to
        look. It’s the difference between a ledger and an advisor.
      </p>
      <div className="gd-say">
        <div className="gd-say-k">Say this</div>
        <p>“QuickBooks waits for you to log in. AgentBook texts you when something needs attention.”</p>
      </div>

      <h2 className="gd-h2">The one-liner</h2>
      <p>
        “AgentBook is an AI bookkeeper you talk to. Snap receipts, send invoices, and it keeps your books and
        taxes done in the background — then warns you before money problems happen.”
      </p>

      <div className="gd-done">
        <span className="gd-check">✓</span>
        <div>
          Next: grab ready-made <Link href="/guides/sales-rep/materials">share cards</Link>, then see{' '}
          <Link href="/guides/sales-rep/earnings">what you can earn</Link>.
        </div>
      </div>

      <div className="gd-chips">
        <Link className="gd-chip" href="/guides/sales-rep">← Partner overview</Link>
        <Link className="gd-chip" href="/guides/sales-rep/materials">Marketing kit</Link>
        <Link className="gd-chip" href="/guides/sales-rep/earnings">Earnings &amp; math</Link>
      </div>

      <Link href="/guides" className="gd-back">&larr; All guides</Link>
    </main>
  );
}
