import React from 'react';
import { Banknote, FilePlus2, Camera } from 'lucide-react';

interface Step {
  icon: React.ReactNode;
  label: string;
  href: string;
  done: boolean;
}

interface Props {
  hasBank: boolean;
  hasInvoice: boolean;
  hasReceipt: boolean;
}

export const OnboardingHero: React.FC<Props> = ({ hasBank, hasInvoice, hasReceipt }) => {
  const steps: Step[] = [
    { icon: <Banknote className="w-5 h-5" />, label: 'Link bank account', href: '/agentbook/bank',     done: hasBank },
    { icon: <FilePlus2 className="w-5 h-5" />, label: 'Add first invoice',   href: '/agentbook/invoices/new', done: hasInvoice },
    { icon: <Camera className="w-5 h-5" />,   label: 'Snap a receipt',     href: '/agentbook/expenses/new', done: hasReceipt },
  ];

  return (
    <section className="bg-card border border-border rounded-2xl p-4 sm:p-6">
      <h2 className="text-lg font-bold text-foreground mb-1">Welcome to AgentBook</h2>
      <p className="text-sm text-muted-foreground mb-4">Three steps to bring your dashboard to life.</p>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={i}>
            <a
              href={s.href}
              className={`flex items-center gap-3 rounded-xl border p-3 transition ${s.done ? 'border-green-500/30 bg-green-500/5' : 'border-border hover:bg-muted/30'}`}
            >
              <span className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">{s.icon}</span>
              <span className="flex-1 text-sm text-foreground">{i + 1}. {s.label}</span>
              {s.done && <span className="text-green-600 text-sm">✓</span>}
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
};
