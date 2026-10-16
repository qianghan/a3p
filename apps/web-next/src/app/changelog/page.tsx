import Link from 'next/link';
import type { Metadata } from 'next';
import { Wordmark } from '@/components/brand/Wordmark';

export const metadata: Metadata = {
  title: 'Changelog — AgentBook',
  description:
    'What changed in AgentBook, newest first. Plain language, real dates.',
  alternates: { canonical: '/changelog' },
  openGraph: {
    title: 'Changelog — AgentBook',
    description: 'What changed in AgentBook, newest first. Plain language, real dates.',
  },
};

// P0-9: dated changelog. Entries are user-facing and plain-language — no
// internal ticket numbers, no unverifiable claims. Newest first.
const ENTRIES: Array<{ date: string; title: string; body: string }> = [
  {
    date: '2026-10-16',
    title: 'Transparent pricing, everywhere',
    body: 'Prices on the homepage now show the currency and region explicitly (USD, CAD, AUD…) instead of a bare dollar sign, and all four add-ons — Tax Fast-Track, Student Success, Personal Insights, Startup Tax Benefits — are listed with their prices instead of living behind a sales conversation.',
  },
  {
    date: '2026-10-16',
    title: 'Try before you sign up',
    body: 'A two-minute interactive demo lets you log an expense in plain English, see a spending report, and get one insight — no account, nothing saved, nothing sent anywhere.',
  },
  {
    date: '2026-10-16',
    title: 'Telegram connects in one click',
    body: 'Linking Telegram no longer needs a bot token and a settings screen. Tap connect, open the link, press start — done. (Bring-your-own-token still works under Advanced.)',
  },
  {
    date: '2026-10-16',
    title: 'About page and honest testimonials',
    body: 'A new About page says who builds AgentBook, what it is, and what it is not. Placeholder testimonials were removed — we would rather show no quotes than invented ones.',
  },
  {
    date: '2026-10-16',
    title: 'Clearer words about taxes',
    body: 'Marketing copy now consistently says "tax prep", never "tax filing". AgentBook prepares your package; you (or your CPA) file it. It does not transmit returns to any tax authority.',
  },
  {
    date: '2026-10-16',
    title: 'Fair-use policy for AI',
    body: 'Every plan now has a published monthly AI usage ceiling. You get a heads-up at 70% and 90%; at 100% AI features pause until next month instead of generating surprise costs. Details in the Terms.',
  },
];

export default function ChangelogPage() {
  return (
    <div className="ab-changelog min-h-screen w-full">
      <style>{`
        .ab-changelog {
          --paper: #f4ecd9; --ink: #1a1714; --ink-soft: #3a342c;
          --muted: #7a7163; --rule: #d6cdb6; --accent-text: #0c6e57;
          background: var(--paper); color: var(--ink);
        }
      `}</style>
      <header className="max-w-[46rem] mx-auto px-6 pt-20 pb-8">
        <Link href="/" className="inline-block mb-8 opacity-80 hover:opacity-100">
          <Wordmark size={30} />
        </Link>
        <h1 className="text-4xl font-medium tracking-tight">Changelog</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-[var(--ink-soft)]">
          What changed in AgentBook, newest first. Plain language, real dates —
          no internal ticket numbers.
        </p>
      </header>
      <main className="max-w-[46rem] mx-auto px-6 pb-24">
        <ol className="relative border-l border-[var(--rule)] ml-2">
          {ENTRIES.map((e) => (
            <li key={`${e.date}-${e.title}`} className="pl-8 pb-10 relative">
              <span
                aria-hidden
                className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full bg-[var(--accent-text)]"
              />
              <time className="text-[12px] uppercase tracking-[0.14em] text-[var(--muted)]">
                {e.date}
              </time>
              <h2 className="mt-1 text-xl font-medium">{e.title}</h2>
              <p className="mt-2 text-[14.5px] leading-relaxed text-[var(--ink-soft)]">
                {e.body}
              </p>
            </li>
          ))}
        </ol>
        <p className="text-[13px] text-[var(--muted)]">
          AgentBook is not a licensed CPA and does not provide tax or legal
          advice. <Link href="/legal/terms" className="underline">Terms</Link> ·{' '}
          <Link href="/legal/privacy" className="underline">Privacy</Link>
        </p>
      </main>
    </div>
  );
}
