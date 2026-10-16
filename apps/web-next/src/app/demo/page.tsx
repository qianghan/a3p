import Link from 'next/link';
import type { Metadata } from 'next';
import { DemoSandbox } from './demo-sandbox';

export const metadata: Metadata = {
  title: 'Try the demo — AgentBook',
  description:
    'A two-minute sandbox: log an expense in plain English, see a report, get an insight. No signup, nothing saved.',
};

// P0-5: pre-signup interactive demo. Fully client-side, fictional seeded
// data, in-memory only — nothing persists, no account, no backend calls.
export default function DemoPage() {
  return (
    <div className="ab-demo min-h-screen w-full">
      <style>{`
        .ab-demo {
          --paper: #f4ecd9; --paper-deep: #ebe1c8; --ink: #1a1714; --ink-soft: #3a342c;
          --muted: #7a7163; --rule: #d6cdb6; --accent-text: #0c6e57; --accent: #149578;
          background: var(--paper); color: var(--ink);
          font-family: var(--font-body, Georgia, serif);
        }
        .ab-demo .wrap { max-width: 860px; margin: 0 auto; padding: 0 28px; }
        .ab-demo .eyebrow {
          font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase;
          color: var(--muted); font-family: var(--font-num, monospace);
        }
        .ab-demo h1 { font-size: 40px; line-height: 1.02; font-weight: 500; margin: 20px 0 0; }
        .ab-demo .lede { font-size: 16.5px; line-height: 1.65; color: var(--ink-soft); margin: 16px 0 0; max-width: 60ch; }
        .ab-demo a.ab-link { color: var(--accent-text); text-decoration: underline; text-underline-offset: 3px; }
        .ab-demo .demo-banner {
          margin-top: 24px; border: 1px dashed var(--muted); border-radius: 2px;
          padding: 12px 16px; font-size: 13.5px; color: var(--ink-soft);
          background: rgba(255,255,255,0.35);
        }
      `}</style>

      <header className="wrap" style={{ paddingTop: 32 }}>
        <Link href="/" aria-label="AgentBook home" style={{ fontSize: 22, fontWeight: 600 }}>
          AgentBook
        </Link>
      </header>

      <main className="wrap" style={{ paddingTop: 48, paddingBottom: 96 }}>
        <div className="eyebrow">Interactive demo</div>
        <h1>
          Two minutes. <em>No signup.</em>
        </h1>
        <p className="lede">
          This is a sandbox with a fictional freelance business. Type an expense
          the way you&apos;d text it, ask for a report, get an insight — the
          core loop of AgentBook, minus the account.
        </p>
        <div className="demo-banner">
          Demo only — fictional data, nothing is saved, and nothing leaves your
          browser. The real AgentBook keeps double-entry books behind this same
          conversational surface.
        </div>

        <DemoSandbox />

        <p className="lede" style={{ marginTop: 40 }}>
          Like what you see?{' '}
          <Link href="/register" className="ab-link">
            Start free — 90 days of Pro, no card
          </Link>
          .
        </p>
      </main>
    </div>
  );
}
