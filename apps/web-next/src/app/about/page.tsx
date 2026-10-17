import Link from 'next/link';
import type { Metadata } from 'next';
import { Wordmark } from '@/components/brand/Wordmark';
import { T } from '@/components/i18n/t';
import { HomeLink } from '@/components/i18n/home-link';

export const metadata: Metadata = {
  title: 'About — AgentBook',
  description:
    'Who builds AgentBook, what it is, what it is not, and how to reach us.',
  alternates: { canonical: '/about' },
  openGraph: {
    title: 'About — AgentBook',
    description:
      'Who builds AgentBook, what it is, what it is not, and how to reach us.',
  },
};

// P0-3: trust infrastructure. Every claim below is verifiable:
// founder from the public repo (github.com/qianghan/a3p), contact from the
// Terms, markets from the product. No user counts, no invented team.
export default function AboutPage() {
  return (
    <div className="ab-about min-h-screen w-full">
      <style>{`
        .ab-about {
          --paper: #f4ecd9; --ink: #1a1714; --ink-soft: #3a342c;
          --muted: #7a7163; --rule: #d6cdb6; --accent-text: #0c6e57;
          background: var(--paper); color: var(--ink);
          font-family: var(--font-body, Georgia, serif);
        }
        .ab-about .wrap { max-width: 760px; margin: 0 auto; padding: 0 28px; }
        .ab-about .eyebrow {
          font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase;
          color: var(--muted); font-family: var(--font-num, monospace);
        }
        .ab-about h1 { font-size: 44px; line-height: 1.02; font-weight: 500; margin: 20px 0 0; }
        .ab-about h2 { font-size: 24px; font-weight: 500; margin: 44px 0 0; }
        .ab-about p { font-size: 16.5px; line-height: 1.65; color: var(--ink-soft); margin: 16px 0 0; max-width: 62ch; }
        .ab-about .rule { height: 1px; background: var(--rule); margin: 28px 0; }
        .ab-about a.ab-link { color: var(--accent-text); text-decoration: underline; text-underline-offset: 3px; }
      `}</style>

      <header className="wrap" style={{ paddingTop: 32 }}>
        <HomeLink>
          <Wordmark size={28} />
        </HomeLink>
      </header>

      <main className="wrap" style={{ paddingTop: 56, paddingBottom: 96 }}>
        <div className="eyebrow"><T k="core_ui.about" /></div>
        <h1>
          Bookkeeping for people who never wanted to be{' '}
          <em>bookkeepers.</em>
        </h1>
        <p>
          AgentBook is an AI bookkeeping and finance assistant for freelancers,
          small businesses, startups, and students. You talk in plain English —
          in the web app, on Telegram, or by email — and it keeps real
          double-entry books: expenses, invoices, receipts, bank sync, reports,
          and tax estimates for the United States, Canada, and Australia.
        </p>

        <h2><T k="common.about_who_builds_it" /></h2>
        <p>
          <T k="common.about_built_by_lead" />{' '}
          <strong><T k="common.about_founder_name" /></strong>, an independent
          developer based in Vancouver, BC, Canada. It is a small, deliberately
          quiet operation — no sales team, no growth department. The public
          source history lives at{' '}
          <a className="ab-link" href="https://github.com/qianghan/a3p">
            github.com/qianghan/a3p
          </a>
          .
        </p>

        <h2><T k="common.about_what_it_is_not" /></h2>
        <p>
          <T k="common.about_not_cpa_lead" />{' '}
          <strong><T k="common.about_not_cpa_emph" /></strong> a licensed
          CPA, tax advisor, or attorney, and it does not give legal advice. It
          does not file your taxes — it prepares the package; you (or your
          accountant) file it. You remain responsible for the accuracy of your
          filings. Always review machine-generated entries before committing
          them to a filing.
        </p>

        <h2><T k="common.about_data_heading" /></h2>
        <p>
          Your books are yours: journal entries, transactions, invoices, and
          attachments export cleanly (CSV, JSON, CPA-ready package) any time,
          including if you leave. Bank connections use Plaid; tokens are
          encrypted at rest. Details are in the{' '}
          <Link className="ab-link" href="/legal/privacy">
            <T k="common.about_privacy_policy" />
          </Link>{' '}
          and{' '}
          <Link className="ab-link" href="/legal/terms">
            <T k="common.about_terms_of_service" />
          </Link>
          .
        </p>

        <div className="rule" />

        <h2><T k="common.about_reach_us" /></h2>
        <p>
          Support:{' '}
          <a className="ab-link" href="mailto:support@agentbook.io">
            support@agentbook.io
          </a>
          . We read everything.
        </p>

        <p style={{ marginTop: 48 }}>
          <Link className="ab-link" href="/">
            &larr; Back to home
          </Link>
        </p>
      </main>
    </div>
  );
}
