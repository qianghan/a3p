import type { Metadata } from 'next';
import Link from 'next/link';
import { Fraunces, Newsreader, JetBrains_Mono } from 'next/font/google';
import { Wordmark } from '@/components/brand/Wordmark';
import { InstallAppButton } from '@/components/pwa/InstallAppButton';

// ─── Type-as-design ─────────────────────────────────────────────────────────
// Fraunces: a variable serif with optical sizing — characterful at display
// scale, refined at body. Pairs with Newsreader (purpose-built for reading)
// and JetBrains Mono for numbers, which feels right for a bookkeeping page.

// Fraunces is a variable font — when using `axes`, weight must be 'variable'.
const display = Fraunces({
  subsets: ['latin'],
  weight: 'variable',
  style: ['normal', 'italic'],
  axes: ['SOFT', 'opsz'],
  variable: '--font-display',
  display: 'swap',
});

const body = Newsreader({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-body',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-num',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'AgentBook — Bookkeeping that listens.',
  description:
    'An AI accountant for solo founders, freelancers, and micro-businesses. Talk to your books in plain English. Telegram, web, receipts, taxes — handled.',
};

// ─── Reusable bits ──────────────────────────────────────────────────────────

function Hairline({ className = '' }: { className?: string }) {
  return <div className={`h-px bg-[var(--rule)] ${className}`} />;
}

function Marker({ n, label }: { n: string; label: string }) {
  return (
    <div className="flex items-baseline gap-3 text-[12px] tracking-[0.18em] uppercase text-[var(--muted)]">
      <span className="font-[var(--font-num)] text-[var(--accent-text)] font-medium">{n}</span>
      <span className="font-[var(--font-num)]">{label}</span>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div
      className={`${display.variable} ${body.variable} ${mono.variable} ab-landing min-h-screen w-full overflow-x-clip`}
      style={
        {
          // Override any dark-mode classes from the global theme. The landing
          // commits to a single cream-paper aesthetic; the dashboard inside
          // does its own thing.
          ['--paper' as string]: '#f4ecd9',
          ['--paper-deep' as string]: '#ebe1c8',
          ['--ink' as string]: '#1a1714',
          ['--ink-soft' as string]: '#3a342c',
          ['--muted' as string]: '#7a7163',
          ['--rule' as string]: '#d6cdb6',
          ['--accent' as string]: '#149578', // brand teal — 3.75:1 on --paper, large-text/background use only
          ['--accent-soft' as string]: '#62cda2', // brand mint — background/fill use only, fails AA as text
          // QA-P5-007: small (~11-12px) uppercase labels using --accent
          // directly failed WCAG AA (3.75:1, needs 4.5:1). Large headings
          // and background/pill fills already clear AA and keep --accent.
          ['--accent-text' as string]: '#0c6e57',
          ['--money' as string]: '#1d4d3a', // deep emerald
          background: 'var(--paper)',
          color: 'var(--ink)',
          fontFamily: 'var(--font-body), Georgia, serif',
        } as React.CSSProperties
      }
    >
      {/* ── Global scoped styles ─────────────────────────────────────────── */}
      <style>{`
        .ab-landing {
          --font-display-stack: var(--font-display), 'Times New Roman', serif;
          --font-num-stack: var(--font-num), ui-monospace, Menlo, monospace;
        }
        .ab-landing h1, .ab-landing h2, .ab-landing h3, .ab-landing .display {
          font-family: var(--font-display-stack);
          font-feature-settings: 'ss01', 'kern', 'liga';
          font-variation-settings: 'opsz' 144, 'SOFT' 0;
          letter-spacing: -0.02em;
        }
        .ab-landing .num { font-family: var(--font-num-stack); font-variant-numeric: tabular-nums; }
        .ab-landing .ital { font-style: italic; font-variation-settings: 'opsz' 144, 'SOFT' 100; }
        /* Faint paper grain */
        .ab-landing::before {
          content: '';
          position: fixed; inset: 0; pointer-events: none; z-index: 1;
          background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' seed='3'/><feColorMatrix values='0 0 0 0 0.10  0 0 0 0 0.09  0 0 0 0 0.07  0 0 0 0.08 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
          opacity: .55; mix-blend-mode: multiply;
        }
        .ab-landing > * { position: relative; z-index: 2; }
        /* Section reveal — runs once on load with staggered delays */
        @keyframes ab-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
        .ab-rise { opacity: 0; animation: ab-rise 0.9s cubic-bezier(0.22, 1, 0.36, 1) forwards; }
        .d-0 { animation-delay: 0ms; } .d-1 { animation-delay: 90ms; }
        .d-2 { animation-delay: 180ms; } .d-3 { animation-delay: 280ms; }
        .d-4 { animation-delay: 400ms; } .d-5 { animation-delay: 540ms; }
        @keyframes ab-blink { 50% { opacity: 0; } }
        .caret::after { content: '▌'; margin-left: 2px; color: var(--accent); animation: ab-blink 1.05s steps(2) infinite; }
        /* Underline that draws on hover */
        .ab-link { background-image: linear-gradient(currentColor, currentColor); background-size: 100% 1px; background-position: 0 100%; background-repeat: no-repeat; padding-bottom: 1px; transition: background-size 0.3s; }
        .ab-link:hover { background-size: 0 1px; }
        /* Asymmetric card */
        .ab-card { border: 1px solid var(--rule); background: rgba(255,255,255,0.35); }
        .ab-card.featured { background: var(--ink); color: var(--paper); border-color: var(--ink); }
        .ab-card.featured .num, .ab-card.featured h3, .ab-card.featured a { color: var(--paper); }
        .ab-card.featured .pill { background: var(--accent); color: var(--paper); }
        .pill { display: inline-block; padding: 4px 9px; border-radius: 999px; font-family: var(--font-num-stack); font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase; }
        .pill-paper { background: var(--paper-deep); color: var(--ink-soft); }
        .pill-accent { background: var(--accent); color: var(--paper); }
        .pill-money { background: var(--money); color: var(--paper); }
        .btn { display: inline-flex; align-items: center; gap: 10px; padding: 14px 22px; font-family: var(--font-num-stack); font-size: 13.5px; letter-spacing: 0.04em; text-transform: uppercase; transition: transform .2s, box-shadow .2s, background .2s, color .2s; cursor: pointer; }
        .btn-primary { background: var(--ink); color: var(--paper); }
        .btn-primary:hover { background: var(--accent); transform: translateY(-1px); }
        .btn-ghost { background: transparent; color: var(--ink); border: 1px solid var(--ink); }
        .btn-ghost:hover { background: var(--ink); color: var(--paper); }
        .btn .arrow { transition: transform .25s; }
        .btn:hover .arrow { transform: translateX(4px); }
        /* Section markers */
        section { padding: 0; }
        .container-rule { max-width: 1240px; margin: 0 auto; padding-inline: 28px; }
        @media (min-width: 768px) { .container-rule { padding-inline: 56px; } }
        /* Drop cap for editorial intro paragraph */
        .dropcap::first-letter {
          font-family: var(--font-display-stack); float: left; font-size: 5.6em; line-height: 0.82;
          padding-right: 12px; padding-top: 6px; font-weight: 500; color: var(--accent);
        }
      `}</style>

      {/* ── Nav ───────────────────────────────────────────────────────────── */}
      <header className="container-rule pt-6 sm:pt-8">
        <div className="flex items-center justify-between">
          <Link href="/" className="flex items-baseline gap-2.5 group">
            <Wordmark size={28} />
            <span className="num text-[10.5px] tracking-[0.22em] uppercase text-[var(--muted)] hidden sm:inline">
              est. 2026
            </span>
          </Link>
          <nav className="flex items-center gap-7 text-[14px]">
            <a className="ab-link hidden sm:inline" href="#how">How it works</a>
            <a className="ab-link hidden sm:inline" href="#pricing">Pricing</a>
            <a className="ab-link hidden md:inline" href="#voices">Voices</a>
            <InstallAppButton />
            <Link
              href="/login"
              className="ab-link num text-[12px] tracking-[0.14em] uppercase"
            >
              Sign in
            </Link>
            <Link href="/register" className="btn btn-primary text-[12px] !py-2.5 !px-4">
              Start free
            </Link>
          </nav>
        </div>
        <Hairline className="mt-5" />
      </header>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="container-rule pt-14 sm:pt-24 pb-20 sm:pb-32">
        <div className="grid grid-cols-12 gap-x-8 gap-y-12">
          {/* Left: transcript design element */}
          <aside className="col-span-12 lg:col-span-5 ab-rise d-0 order-2 lg:order-1">
            <Marker n="—" label="A typical Tuesday" />
            <div className="mt-5 ab-card p-6 sm:p-7" style={{ borderRadius: '2px' }}>
              <div className="text-[12px] num text-[var(--muted)] mb-4">9:47 AM · Telegram</div>
              <div className="space-y-3.5 text-[15px] leading-relaxed">
                <div className="flex gap-3">
                  <span className="text-[var(--muted)] num text-[11px] pt-1 shrink-0 w-6">YOU</span>
                  <p>drove 24 miles to acme today, then $14 for parking</p>
                </div>
                <div className="flex gap-3">
                  <span className="text-[var(--accent-text)] num text-[11px] pt-1 shrink-0 w-6">AB</span>
                  <p>
                    Logged. <span className="num">24 mi</span> to Acme (client visit, billable),{' '}
                    <span className="num">$14.00</span> parking under Travel.{' '}
                    <span className="ital text-[var(--ink-soft)]">Anything else?</span>
                  </p>
                </div>
                <div className="flex gap-3">
                  <span className="text-[var(--muted)] num text-[11px] pt-1 shrink-0 w-6">YOU</span>
                  <p>send the invoice to acme for last month</p>
                </div>
                <div className="flex gap-3">
                  <span className="text-[var(--accent-text)] num text-[11px] pt-1 shrink-0 w-6">AB</span>
                  <p>
                    Drafted INV-2026-042 — <span className="num">$4,840</span>, net-30. Want me to send
                    it now or hold for review?
                    <span className="caret" />
                  </p>
                </div>
              </div>
              <div className="mt-6 pt-4 border-t border-[var(--rule)] flex items-center justify-between text-[11px] num text-[var(--muted)] uppercase tracking-[0.14em]">
                <span>2 entries booked</span>
                <span>1 invoice drafted</span>
                <span>0 spreadsheets opened</span>
              </div>
            </div>
            <p className="mt-5 text-[14px] text-[var(--muted)] italic leading-relaxed max-w-[36ch]">
              That's the entire interaction. No forms. No reconciling. Books stay closed-loop
              accurate — because the agent writes journal entries, not just notes.
            </p>
          </aside>

          {/* Right: editorial headline */}
          <div className="col-span-12 lg:col-span-7 lg:pl-8 order-1 lg:order-2">
            <div className="ab-rise d-1">
              <Marker n="01" label="The thesis" />
            </div>
            <h1
              className="ab-rise d-2 mt-6 text-[14vw] sm:text-[10vw] lg:text-[7.6vw] xl:text-[110px] leading-[0.92]"
              style={{ fontWeight: 400, fontVariationSettings: "'opsz' 144, 'SOFT' 0" }}
            >
              Bookkeeping<br />
              <span className="ital text-[var(--accent)]">that listens.</span>
            </h1>
            <p className="ab-rise d-3 mt-8 max-w-[46ch] text-[19px] sm:text-[20px] leading-[1.55] text-[var(--ink-soft)]">
              AgentBook is an AI accountant for the people who never wanted to be one. Talk to
              your books in plain English — over Telegram, web, or your inbox. The agent does
              the rest. <span className="ital text-[var(--muted)]">Quietly. Accurately. While you sleep.</span>
            </p>

            <div className="ab-rise d-4 mt-10 flex flex-wrap gap-3 items-center">
              <Link href="/register" className="btn btn-primary">
                Start free, no card
                <span className="arrow">→</span>
              </Link>
              <Link href="#pricing" className="btn btn-ghost">
                See plans
              </Link>
              <span className="num text-[11.5px] text-[var(--muted)] tracking-[0.16em] uppercase ml-2">
                90 days of Pro · free
              </span>
            </div>

            <div className="ab-rise d-5 mt-14 pt-8 border-t border-[var(--rule)] grid grid-cols-3 gap-6 text-[13px]">
              <div>
                <div className="display text-[34px] leading-none num" style={{ fontWeight: 500 }}>
                  ¢/min
                </div>
                <p className="mt-2 text-[var(--muted)]">
                  What an hour of manual bookkeeping costs you, after agents.
                </p>
              </div>
              <div>
                <div className="display text-[34px] leading-none num" style={{ fontWeight: 500 }}>
                  T-1
                </div>
                <p className="mt-2 text-[var(--muted)]">
                  Receipts entered same-day, not month-end.
                </p>
              </div>
              <div>
                <div className="display text-[34px] leading-none num" style={{ fontWeight: 500 }}>
                  Q4↓
                </div>
                <p className="mt-2 text-[var(--muted)]">
                  Tax-season panic — eliminated by design.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <Hairline />

      {/* ── For who ──────────────────────────────────────────────────────── */}
      <section className="container-rule py-20 sm:py-28">
        <div className="grid grid-cols-12 gap-x-8 gap-y-10">
          <div className="col-span-12 md:col-span-5">
            <Marker n="02" label="Who it's for" />
            <h2 className="mt-5 text-[40px] sm:text-[56px] leading-[0.96]" style={{ fontWeight: 400 }}>
              For the ones <br />
              <span className="ital">running it all,</span> <br />
              <span className="text-[var(--muted)]">alone or nearly.</span>
            </h2>
          </div>
          <div className="col-span-12 md:col-span-7 md:pl-8 grid sm:grid-cols-2 gap-7">
            {[
              {
                tag: 'Solo consultant',
                copy:
                  'You bill by the hour. You also write your own contracts, send your own invoices, and chase your own clients. AgentBook is the part you forget exists.',
              },
              {
                tag: 'Etsy / Shopify seller',
                copy:
                  'Stripe fees, USPS labels, raw materials, the occasional refund. We thread the bookkeeping through your sales — no CSV exports, no month-end heroics.',
              },
              {
                tag: 'Agency owner',
                copy:
                  'You bill three clients on net-30 and pay six contractors. Time entries become invoices. Invoices become receivables. Receivables become a CPA-ready package.',
              },
              {
                tag: 'Side-hustler',
                copy:
                  "Day job pays the rent; this pays for the weekend. We keep the second set of books tax-ready so the IRS doesn't surprise you next April.",
              },
              {
                tag: 'Student',
                copy:
                  "Your first paycheck, a scholarship that might not all be tax-free, a tutoring gig on the side. We translate the parts nobody teaches you, in plain English — US, Canada, or Australia. Just ask, in chat: Student Success finds scholarships, co-ops, and a roommate for you in the US and Canada — cited, real searches, nothing to browse.",
              },
            ].map((p) => (
              <div key={p.tag} className="border-l-2 border-[var(--rule)] pl-5">
                <div className="pill pill-paper">{p.tag}</div>
                <p className="mt-3 text-[15.5px] leading-[1.6] text-[var(--ink-soft)]">
                  {p.copy}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Hairline />

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section id="how" className="container-rule py-20 sm:py-28">
        <div className="grid grid-cols-12 gap-8">
          <div className="col-span-12 lg:col-span-4">
            <Marker n="03" label="How it works" />
            <h2 className="mt-5 text-[40px] sm:text-[56px] leading-[0.96]" style={{ fontWeight: 400 }}>
              Three doorways. <br /><span className="ital">One ledger.</span>
            </h2>
            <p className="dropcap mt-6 text-[17px] leading-[1.65] text-[var(--ink-soft)] max-w-[40ch]">
              Talk to the agent the way you'd talk to a bookkeeper at the pub. It writes proper
              journal entries — double-entry, auditable, exportable. The interface is
              forgiving. The accounting underneath isn't.
            </p>
          </div>

          <div className="col-span-12 lg:col-span-8 grid sm:grid-cols-3 gap-5">
            {[
              {
                n: 'i',
                title: 'Telegram',
                body: '"log $5 coffee", "drove 30 miles", "what did I spend on travel last month" — replies in under a second.',
              },
              {
                n: 'ii',
                title: 'Web chat',
                body: 'The same agent, with attachments. Drop a receipt photo, a PDF statement, a bank CSV. It picks up where you left off.',
              },
              {
                n: 'iii',
                title: 'Email & cron',
                body: 'Weekly digests, payment reminders, deduction discovery, quarterly tax estimates — sent before you ask.',
              },
            ].map((s) => (
              <div key={s.title} className="border-t border-[var(--ink)] pt-5">
                <span className="num text-[12px] tracking-[0.18em] uppercase text-[var(--accent-text)]">
                  {s.n}
                </span>
                <h3 className="mt-2 text-[26px] leading-tight" style={{ fontWeight: 500 }}>
                  {s.title}
                </h3>
                <p className="mt-3 text-[14.5px] leading-[1.6] text-[var(--ink-soft)]">{s.body}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Pull quote */}
        <figure className="mt-24 max-w-[64ch] mx-auto text-center">
          <blockquote className="ital text-[28px] sm:text-[40px] leading-[1.12] text-[var(--ink)]" style={{ fontWeight: 400 }}>
            "I closed Q3 in seven minutes from a hammock in Tofino. The previous quarter took
            me half a Saturday."
          </blockquote>
          <figcaption className="mt-6 num text-[12px] tracking-[0.18em] uppercase text-[var(--muted)]">
            — Maya · Solo consultant, Toronto
          </figcaption>
        </figure>
      </section>

      <Hairline />

      {/* ── Features ─────────────────────────────────────────────────────── */}
      <section className="container-rule py-20 sm:py-28">
        <div className="grid grid-cols-12 gap-x-8 gap-y-10">
          <div className="col-span-12">
            <Marker n="04" label="What's inside" />
            <h2 className="mt-5 text-[40px] sm:text-[56px] leading-[0.96] max-w-[18ch]" style={{ fontWeight: 400 }}>
              A real ledger. <span className="ital">A patient teacher.</span> Doesn't tire.
            </h2>
          </div>

          {[
            {
              n: '4·1',
              h: 'Double-entry, every entry.',
              p: 'Behind the chat is a code-not-LLM constraint engine. Every transaction writes a balanced journal. Trial balance always ties.',
            },
            {
              n: '4·2',
              h: 'Receipts that read themselves.',
              p: 'Snap or forward a receipt. Vendor, amount, tax, category — extracted, queued for one-tap review, then booked.',
            },
            {
              n: '4·3',
              h: 'Invoices in a sentence.',
              p: '"Invoice Acme $5,000 for consulting, net-30." The PDF, payment link, and the AR row appear together. Pay-by-card is on by default.',
            },
            {
              n: '4·4',
              h: 'Bank sync, optional.',
              p: 'Plug Plaid in for live transactions if you want auto-reconciliation. Or stay manual — the agent works either way.',
            },
            {
              n: '4·5',
              h: 'Taxes, on the rails.',
              p: 'Quarterly estimates. P&L, balance sheet, cashflow, expense-by-vendor — all one prompt away. Tax-package export for your CPA in a click.',
            },
            {
              n: '4·6',
              h: 'A second brain for money.',
              p: 'The agent remembers your vendors, your categorization quirks, your client preferences. It gets better the longer you use it.',
            },
            {
              n: '4·7',
              h: 'Tax fast-track filing.',
              p: "A few quick questions — in chat or on the tab — about what changed since last year, and the agent drafts a full estimate plus an accountant-ready cover letter, anchored to your actual prior return. Deadline nudges land before you have to remember. US and Canada today, with Australia's tax rules already built in for what's next.",
            },
            {
              n: '4·8',
              h: 'Student Success, built in.',
              p: '"Find me scholarships." "Find a co-op." "Find a roommate." Just ask — the agent searches, cites its sources, and saves what it finds. Scholarship, Career & Co-op, and Housing copilots, US and Canada today.',
            },
          ].map((f) => (
            <article
              key={f.n}
              className="col-span-12 md:col-span-6 lg:col-span-4 border-t border-[var(--ink)] pt-5"
            >
              <span className="num text-[11.5px] text-[var(--accent-text)] tracking-[0.18em] uppercase">
                {f.n}
              </span>
              <h3 className="mt-2 text-[22px] leading-[1.18]" style={{ fontWeight: 500 }}>
                {f.h}
              </h3>
              <p className="mt-3 text-[14.5px] leading-[1.65] text-[var(--ink-soft)]">{f.p}</p>
            </article>
          ))}
        </div>
      </section>

      <Hairline />

      {/* ── Pricing ──────────────────────────────────────────────────────── */}
      <section id="pricing" className="container-rule py-20 sm:py-28">
        <div className="grid grid-cols-12 gap-x-8 gap-y-10 mb-16">
          <div className="col-span-12 md:col-span-7">
            <Marker n="05" label="Pricing, plainly" />
            <h2 className="mt-5 text-[40px] sm:text-[56px] leading-[0.96]" style={{ fontWeight: 400 }}>
              Try Pro for <span className="ital">ninety days,</span> free.
            </h2>
          </div>
          <div className="col-span-12 md:col-span-5 md:pt-12 md:pl-8">
            <p className="text-[16.5px] leading-[1.6] text-[var(--ink-soft)] max-w-[44ch]">
              No card to start. After the trial, $20 a month or $190 a year — whichever you
              like. Cancel any time, in plain English. We won't make it hard.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* Free */}
          <div className="ab-card p-8" style={{ borderRadius: '2px' }}>
            <div className="flex items-center justify-between">
              <h3 className="text-[28px]" style={{ fontWeight: 500 }}>
                Free
              </h3>
              <span className="pill pill-paper">forever</span>
            </div>
            <div className="mt-5 flex items-baseline gap-2">
              <span className="display num text-[64px] leading-none" style={{ fontWeight: 500 }}>
                $0
              </span>
              <span className="num text-[12px] text-[var(--muted)] tracking-[0.14em] uppercase">/mo</span>
            </div>
            <p className="mt-3 text-[14px] text-[var(--ink-soft)]">
              For getting started. No commitment, no pestering.
            </p>
            <Hairline className="my-6" />
            <ul className="space-y-2.5 text-[14px] text-[var(--ink-soft)]">
              <li>· 50 expenses / month</li>
              <li>· 5 invoices / month</li>
              <li>· 100 AI messages</li>
              <li>· Web chat (no Telegram)</li>
              <li>· Basic reports</li>
            </ul>
            <Link href="/register" className="btn btn-ghost mt-8 w-full justify-center">
              Begin
            </Link>
          </div>

          {/* Pro Annual — featured */}
          <div className="ab-card featured p-8 relative" style={{ borderRadius: '2px' }}>
            <div
              className="absolute top-0 right-7 -translate-y-1/2 pill pill-accent"
              style={{ letterSpacing: '0.18em' }}
            >
              Recommended
            </div>
            <div className="flex items-center justify-between">
              <h3 className="text-[28px]" style={{ fontWeight: 500 }}>
                Pro Annual
              </h3>
              <span className="pill pill-paper" style={{ background: 'rgba(244,236,217,0.16)', color: 'var(--paper)' }}>
                save 20%
              </span>
            </div>
            <div className="mt-5 flex items-baseline gap-2">
              <span className="display num text-[64px] leading-none" style={{ fontWeight: 500 }}>
                $190
              </span>
              <span className="num text-[12px] text-[var(--paper)] opacity-70 tracking-[0.14em] uppercase">/yr</span>
            </div>
            <p className="mt-3 text-[14px] opacity-80">
              $15.83/mo, paid up front. Same as Monthly otherwise.
            </p>
            <Hairline className="my-6" />
            <ul className="space-y-2.5 text-[14px] opacity-90">
              <li>· Unlimited expenses, invoices, AI</li>
              <li>· Telegram bot, web, email</li>
              <li>· Receipt OCR, bank sync (Plaid)</li>
              <li>· Tax estimate, tax-package export</li>
              <li>· P&L, balance sheet, cashflow</li>
              <li>· 90-day free trial</li>
            </ul>
            <Link
              href="/register?plan=pro-yearly"
              className="btn mt-8 w-full justify-center"
              style={{ background: 'var(--paper)', color: 'var(--ink)' }}
            >
              Start 90-day trial
              <span className="arrow">→</span>
            </Link>
          </div>

          {/* Pro Monthly */}
          <div className="ab-card p-8" style={{ borderRadius: '2px' }}>
            <div className="flex items-center justify-between">
              <h3 className="text-[28px]" style={{ fontWeight: 500 }}>
                Pro Monthly
              </h3>
              <span className="pill pill-paper">flexible</span>
            </div>
            <div className="mt-5 flex items-baseline gap-2">
              <span className="display num text-[64px] leading-none" style={{ fontWeight: 500 }}>
                $20
              </span>
              <span className="num text-[12px] text-[var(--muted)] tracking-[0.14em] uppercase">/mo</span>
            </div>
            <p className="mt-3 text-[14px] text-[var(--ink-soft)]">
              Cancel any time. Same features as Annual.
            </p>
            <Hairline className="my-6" />
            <ul className="space-y-2.5 text-[14px] text-[var(--ink-soft)]">
              <li>· Everything in Pro Annual</li>
              <li>· Billed monthly</li>
              <li>· Cancel anytime</li>
              <li>· 90-day free trial</li>
            </ul>
            <Link href="/register?plan=pro" className="btn btn-ghost mt-8 w-full justify-center">
              Start 90-day trial
            </Link>
          </div>
        </div>

        <p className="mt-10 text-center text-[13px] num text-[var(--muted)] tracking-[0.12em] uppercase">
          All plans · cancel any time · we never charge during your trial · your data exports
          cleanly
        </p>
      </section>

      <Hairline />

      {/* ── Voices ───────────────────────────────────────────────────────── */}
      <section id="voices" className="container-rule py-20 sm:py-28">
        <div className="grid grid-cols-12 gap-x-8 gap-y-12">
          <div className="col-span-12">
            <Marker n="06" label="Voices" />
            <h2 className="mt-5 text-[40px] sm:text-[56px] leading-[0.96] max-w-[24ch]" style={{ fontWeight: 400 }}>
              The notes our users write us, <span className="ital">unprompted.</span>
            </h2>
          </div>

          {[
            {
              q: '"I stopped dreading the end of the month. The agent had already done it."',
              n: 'Alex',
              role: 'Agency owner · Brooklyn',
            },
            {
              q: '"It picks better expense categories than I do. My CPA actually said thank you."',
              n: 'Maya',
              role: 'Solo consultant · Toronto',
            },
            {
              q: '"Telegram. I cannot stress this enough. I log a coffee from the line at the coffee place."',
              n: 'Jordan',
              role: 'Etsy seller · Portland',
            },
          ].map((t) => (
            <figure key={t.n} className="col-span-12 md:col-span-4">
              <blockquote className="ital text-[20px] sm:text-[22px] leading-[1.4]" style={{ fontWeight: 400 }}>
                {t.q}
              </blockquote>
              <figcaption className="mt-5 pt-4 border-t border-[var(--rule)] text-[12.5px] num uppercase tracking-[0.14em] text-[var(--muted)]">
                <span className="text-[var(--ink)]">{t.n}</span>
                <span> · {t.role}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      <Hairline />

      {/* ── FAQ ──────────────────────────────────────────────────────────── */}
      <section className="container-rule py-20 sm:py-28">
        <div className="grid grid-cols-12 gap-x-8 gap-y-8">
          <div className="col-span-12 md:col-span-4">
            <Marker n="07" label="Frequent questions" />
            <h2 className="mt-5 text-[40px] sm:text-[52px] leading-[0.96]" style={{ fontWeight: 400 }}>
              <span className="ital">Short</span> <br />
              answers <br />
              to fair <br />
              questions.
            </h2>
          </div>
          <div className="col-span-12 md:col-span-8 md:pl-8">
            <dl className="divide-y divide-[var(--rule)]">
              {[
                {
                  q: 'Is the free plan really free?',
                  a: 'Yes — no card, no countdown. The 90-day Pro trial is separate; you pick it deliberately. The Free plan stays Free even after the trial expires.',
                },
                {
                  q: 'What happens after 90 days?',
                  a: 'We email you a week before. If you add a card you stay on Pro. If not, you drop to Free — nothing breaks, you just lose Telegram, OCR, and a few quotas.',
                },
                {
                  q: 'Will my data export if I leave?',
                  a: 'Cleanly. Journal entries, transactions, invoices, attachments — CSV, JSON, and a CPA-ready package. We treat your books as yours, because they are.',
                },
                {
                  q: 'Is this actually accounting, or is it a notes app?',
                  a: 'Actually accounting. Every action writes a balanced double-entry journal under a code-driven constraint engine. The chat is the interface; the ledger is the truth.',
                },
                {
                  q: 'What does the agent NOT do?',
                  a: 'It does not file your taxes. It does not give legal advice. It does not pretend to be your CPA. It prepares the package; you (or your CPA) ship it.',
                },
                {
                  q: 'How much does my CPA hate this?',
                  a: 'Most love it. The exports are properly structured and the audit trail is intact. The ones who hate it usually charge by the hour for data entry.',
                },
              ].map((f, i) => (
                <div key={i} className="py-6">
                  <dt
                    className="text-[20px] sm:text-[22px]"
                    style={{ fontFamily: 'var(--font-display-stack)', fontWeight: 500 }}
                  >
                    {f.q}
                  </dt>
                  <dd className="mt-3 text-[15px] leading-[1.65] text-[var(--ink-soft)] max-w-[60ch]">
                    {f.a}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <Hairline />

      {/* ── Final CTA ────────────────────────────────────────────────────── */}
      <section className="container-rule py-24 sm:py-36 text-center">
        <Marker n="08" label="The invitation" />
        <h2
          className="mt-6 text-[52px] sm:text-[88px] lg:text-[120px] leading-[0.94] max-w-[18ch] mx-auto"
          style={{ fontWeight: 400 }}
        >
          Send your books <br />
          <span className="ital text-[var(--accent)]">a co-worker.</span>
        </h2>
        <p className="mt-8 max-w-[44ch] mx-auto text-[17.5px] leading-[1.6] text-[var(--ink-soft)]">
          Ninety days of Pro, no card, no hooks. After that, $20 a month or $190 a year. Or
          stay on Free. You decide — every time.
        </p>
        <div className="mt-12 flex flex-wrap justify-center gap-3">
          <Link href="/register" className="btn btn-primary">
            Begin · 90 days free
            <span className="arrow">→</span>
          </Link>
          <Link href="/login" className="btn btn-ghost">
            I already have an account
          </Link>
        </div>
      </section>

      <Hairline />

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="container-rule py-12">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-8">
          <div>
            <Wordmark size={36} />
            <p className="mt-3 text-[13px] text-[var(--muted)] max-w-[44ch] leading-[1.5]">
              An AI accountant for the people who never wanted to be one. Built for solo
              founders, freelancers, and the small-team operators who run it all.
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-12 gap-y-2 text-[13.5px]">
            <a href="#how" className="ab-link">How it works</a>
            <a href="#pricing" className="ab-link">Pricing</a>
            <a href="#voices" className="ab-link">Voices</a>
            <Link href="/docs" className="ab-link">Docs</Link>
            <Link href="/login" className="ab-link">Sign in</Link>
            <Link href="/register" className="ab-link">Start free</Link>
          </div>
        </div>
        <Hairline className="my-7" />
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-[11.5px] num uppercase tracking-[0.16em] text-[var(--muted)]">
          <span>© {new Date().getFullYear()} AgentBook · A folio of one ledger</span>
          <span>Built quietly. Yours plainly.</span>
        </div>
      </footer>
    </div>
  );
}
