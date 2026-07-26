import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Guides — AgentBook',
  description: 'Short, do-it-now guides: chat & Claude, everyday workflows, student life, and earning as a partner.',
};

const GUIDES = [
  { n: '01', href: '/guides/chatbot-mcp', title: 'Chat & Claude connector', blurb: 'Talk to AgentBook in the app, on Telegram, or straight from Claude.' },
  { n: '02', href: '/guides/workflows', title: 'Everyday workflows', blurb: 'The three you’ll use most: bookkeeping, tax filing, personal finance.' },
  { n: '03', href: '/guides/students', title: 'Student life', blurb: 'Money, housing, and scholarships — built for students.' },
  { n: '04', href: '/guides/sales-rep', title: 'Earn as a partner', blurb: 'Refer AgentBook and earn 20% — turn it into passive income.' },
  { n: '05', href: '/guides/startup-founders', title: 'For startup founders', blurb: 'Clean books from day one: burn, runway, invoicing, and startup tax.' },
];

export default function GuidesIndex() {
  return (
    <main>
      <div className="gd-eyebrow">Guides</div>
      <h1 className="gd-h1">Get productive in a few minutes</h1>
      <p className="gd-lede">Short, action-first guides. Pick one, follow the steps, done. Most take 2&ndash;3 minutes.</p>

      <div className="gd-cards">
        {GUIDES.map((g) => (
          <Link key={g.href} href={g.href} className="gd-tile">
            <div className="gd-num">{g.n}</div>
            <h3>{g.title}</h3>
            <p>{g.blurb}</p>
            <div className="gd-go">Read &rarr;</div>
          </Link>
        ))}
      </div>

      <Link href="/" className="gd-back">&larr; Back to home</Link>
    </main>
  );
}
