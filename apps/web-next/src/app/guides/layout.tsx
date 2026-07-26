import './guides.css';
import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Guides — AgentBook',
  description: 'Short, do-it-now guides to get the most out of AgentBook.',
};

export default function GuidesLayout({ children }: { children: ReactNode }) {
  return (
    <div className="gd-root">
      <div className="gd-wrap">
        <header className="gd-top">
          <Link href="/" className="gd-brand">Agent<span>Book</span></Link>
          <nav className="gd-topnav">
            <Link href="/guides">All guides</Link>
            <Link href="/register">Get started</Link>
          </nav>
        </header>
        {children}
        <footer className="gd-foot">
          Need more? Open the <a href="/login">app</a> or <a href="/register">create an account</a>. Every guide takes 2–3 minutes.
        </footer>
      </div>
    </div>
  );
}
