import './guides.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { GuidesTop, GuidesFooter } from './_components/GuidesChrome';

export const metadata: Metadata = {
  title: 'Guides — AgentBook',
  description: 'Short, do-it-now guides to get the most out of AgentBook.',
};

export default function GuidesLayout({ children }: { children: ReactNode }) {
  return (
    <div className="gd-root">
      <div className="gd-wrap">
        <GuidesTop />
        {children}
        <GuidesFooter />
      </div>
    </div>
  );
}
