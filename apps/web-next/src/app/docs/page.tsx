import Link from 'next/link';
import { Rocket, Settings, Sparkles, LifeBuoy, ArrowRight } from 'lucide-react';
import { Wordmark } from '@/components/brand/Wordmark';
import { DocsSidebar } from '@/components/docs/docs-sidebar';
import { getNavigation } from '@/lib/docs/content';

export const metadata = {
  title: 'AgentBook Docs',
  description: 'Guides for setting up and using AgentBook — AI bookkeeping for your business and personal finances.',
};

const sections = [
  {
    title: 'Set up',
    description: 'Create your account, connect a bank, and record your first expense in minutes.',
    href: '/docs/setup/quickstart',
    icon: Rocket,
  },
  {
    title: 'Configure',
    description: 'Business profile, accounting basis, bank sync, your accountant, Telegram & alerts.',
    href: '/docs/configure/business-profile',
    icon: Settings,
  },
  {
    title: 'Working day-to-day',
    description: 'Expenses, invoices, reports & tax, and getting the most from the agent.',
    href: '/docs/working/expenses-and-receipts',
    icon: Sparkles,
  },
  {
    title: 'Troubleshooting',
    description: 'Bank sync, fixing a category, and sign-in — quick fixes for common snags.',
    href: '/docs/troubleshooting/bank-not-syncing',
    icon: LifeBuoy,
  },
];

const popular = [
  { label: 'Get started in five minutes', href: '/docs/setup/quickstart' },
  { label: 'Connect your bank', href: '/docs/setup/connect-bank' },
  { label: 'How much tax should I set aside?', href: '/docs/working/reports-and-tax' },
  { label: 'Fix a miscategorized expense', href: '/docs/troubleshooting/fix-a-miscategorized-expense' },
];

export default function DocsHomePage() {
  const navigation = getNavigation();
  return (
    <div className="flex">
      <aside className="hidden lg:block w-64 shrink-0 border-r border-border">
        <div className="sticky top-14 h-[calc(100vh-3.5rem)] overflow-y-auto py-6 px-4">
          <DocsSidebar navigation={navigation} />
        </div>
      </aside>
      <main className="flex-1 min-w-0 px-4 lg:px-8">
      {/* Hero */}
      <div className="max-w-3xl mx-auto pt-16 pb-10 text-center">
        <div className="flex items-center justify-center gap-2 mb-5">
          <Wordmark size={30} />
          <span className="text-2xl font-semibold text-muted-foreground tracking-tight">docs</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight mb-4 text-foreground">
          Guides for getting the most out of AgentBook
        </h1>
        <p className="text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
          Everything you need to set up, configure, and run your books — no accounting knowledge required.
          Prefer to just ask? The agent answers most of this in chat.
        </p>
      </div>

      {/* Popular */}
      <div className="max-w-3xl mx-auto mb-14">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-3 text-center">
          Popular
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {popular.map((p) => (
            <Link
              key={p.href}
              href={p.href}
              className="group flex items-center justify-between gap-2 px-4 py-3 rounded-lg border border-border bg-card hover:border-primary/40 transition-colors"
            >
              <span className="text-sm text-foreground">{p.label}</span>
              <ArrowRight size={14} className="text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
            </Link>
          ))}
        </div>
      </div>

      {/* Section cards */}
      <div className="max-w-4xl mx-auto pb-20">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sections.map((section) => {
            const Icon = section.icon;
            return (
              <Link
                key={section.title}
                href={section.href}
                className="group relative p-6 rounded-xl border border-border bg-card hover:border-primary/40 hover:shadow-lg hover:-translate-y-0.5 transition-all"
              >
                <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
                  <Icon size={20} className="text-primary" />
                </div>
                <h3 className="text-lg font-semibold mb-2 text-foreground">{section.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">{section.description}</p>
                <span className="inline-flex items-center gap-1 text-sm font-medium text-primary group-hover:gap-2 transition-all">
                  Explore
                  <ArrowRight size={14} />
                </span>
              </Link>
            );
          })}
        </div>
      </div>
      </main>
    </div>
  );
}
