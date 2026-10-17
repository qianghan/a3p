'use client';

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/hooks/use-t';

interface DemoExpense {
  id: number;
  description: string;
  amountCents: number;
  category: string;
  date: string;
  source: 'seed' | 'you';
}

interface ChatMsg {
  id: number;
  from: 'user' | 'agent';
  text: string;
}

const CATEGORY_KEYWORDS: Array<[string, string[]]> = [
  ['Travel', ['flight', 'hotel', 'taxi', 'uber', 'airbnb', 'train', 'mileage', 'parking', 'gas']],
  ['Meals', ['lunch', 'dinner', 'coffee', 'breakfast', 'restaurant', 'starbucks', 'food', 'cafe']],
  ['Software', ['github', 'subscription', 'saas', 'adobe', 'figma', 'notion', 'domain', 'hosting', 'slack']],
  ['Office', ['supplies', 'printer', 'desk', 'chair', 'paper', 'staples', 'ink']],
];

const SEED: DemoExpense[] = [
  { id: 1, description: 'Flight to client onsite', amountCents: 42000, category: 'Travel', date: 'Oct 3', source: 'seed' },
  { id: 2, description: 'Team lunch', amountCents: 8600, category: 'Meals', date: 'Oct 7', source: 'seed' },
  { id: 3, description: 'GitHub subscription', amountCents: 400, category: 'Software', date: 'Oct 1', source: 'seed' },
  { id: 4, description: 'Hotel, 2 nights', amountCents: 31800, category: 'Travel', date: 'Oct 4', source: 'seed' },
  { id: 5, description: 'Coffee with prospect', amountCents: 1200, category: 'Meals', date: 'Oct 9', source: 'seed' },
];

function categorize(text: string): string {
  const lower = text.toLowerCase();
  for (const [cat, words] of CATEGORY_KEYWORDS) {
    if (words.some((w) => lower.includes(w))) return cat;
  }
  return 'General';
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

let nextId = 100;

export function DemoSandbox() {
  const t = useT();
  const [expenses, setExpenses] = useState<DemoExpense[]>(SEED);
  const [msgs, setMsgs] = useState<ChatMsg[]>([
    {
      id: 1,
      from: 'agent',
      text: 'Hi — I\'m the demo agent. Try: "Spent $45 on lunch at Starbucks". Or type "report" for your spending breakdown, "insight" for one thing worth knowing.',
    },
  ]);
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  const push = (from: 'user' | 'agent', text: string) =>
    setMsgs((m) => [...m, { id: nextId++, from, text }]);

  const handleReport = () => {
    const totals = new Map<string, number>();
    for (const e of expenses) totals.set(e.category, (totals.get(e.category) ?? 0) + e.amountCents);
    const grand = [...totals.values()].reduce((a, b) => a + b, 0);
    const lines = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([c, v]) => `• ${c}: ${fmt(v)}`)
      .join('\n');
    push('agent', `October so far — ${fmt(grand)} across ${expenses.length} expenses:\n${lines}`);
  };

  const handleInsight = () => {
    const totals = new Map<string, number>();
    for (const e of expenses) totals.set(e.category, (totals.get(e.category) ?? 0) + e.amountCents);
    const grand = [...totals.values()].reduce((a, b) => a + b, 0) || 1;
    const [topCat, topVal] = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
    const pct = Math.round((topVal / grand) * 100);
    push(
      'agent',
      `One thing worth knowing: ${topCat} is ${pct}% of your October spend (${fmt(topVal)}). ` +
        `In the real product I'd watch this weekly and nudge you before it becomes a tax-season surprise — ` +
        `that's the proactive engine, simulated here.`,
    );
  };

  const handleSend = () => {
    const raw = input.trim();
    if (!raw) return;
    setInput('');
    push('user', raw);
    const lower = raw.toLowerCase();

    if (/^(report|summary|spending|how much)/.test(lower)) return handleReport();
    if (/insight/.test(lower)) return handleInsight();
    if (/^(help|\?)/.test(lower)) {
      return push('agent', 'Try: "Spent $45 on lunch", "Log $1200 for a flight to NYC", "report", or "insight".');
    }

    const m = raw.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
    if (!m) {
      return push('agent', 'I need an amount to log — e.g. "Spent $45 on lunch". Type "help" for examples.');
    }
    const cents = Math.round(parseFloat(m[1]) * 100);
    const desc = raw.replace(m[0], '').replace(/^(spent|log|paid|on|for)\s+/i, '').trim() || 'Expense';
    const category = categorize(raw);
    const expense: DemoExpense = {
      id: nextId++,
      description: desc.charAt(0).toUpperCase() + desc.slice(1),
      amountCents: cents,
      category,
      date: 'Today',
      source: 'you',
    };
    setExpenses((e) => [expense, ...e]);
    push(
      'agent',
      `Logged: ${fmt(cents)} — ${expense.description} → ${category}. ` +
        `In the real product this also writes a balanced journal entry; here it's just your sandbox ledger below.`,
    );
  };

  const handleReset = () => {
    setExpenses(SEED);
    setMsgs((m) => [...m, { id: nextId++, from: 'agent', text: 'Sandbox reset — back to the fictional October books.' }]);
  };

  const grand = expenses.reduce((a, e) => a + e.amountCents, 0);

  return (
    <div style={{ marginTop: 32 }}>
      {/* Chat */}
      <div
        style={{
          border: '1px solid var(--rule)', borderRadius: 2, background: 'rgba(255,255,255,0.45)',
          height: 320, overflowY: 'auto', padding: 16,
        }}
      >
        {msgs.map((msg) => (
          <div key={msg.id} style={{ marginBottom: 12, textAlign: msg.from === 'user' ? 'right' : 'left' }}>
            <div
              style={{
                display: 'inline-block', maxWidth: '85%', textAlign: 'left',
                background: msg.from === 'user' ? 'var(--ink)' : '#fff',
                color: msg.from === 'user' ? 'var(--paper)' : 'var(--ink)',
                border: msg.from === 'user' ? 'none' : '1px solid var(--rule)',
                borderRadius: 12, padding: '8px 14px', fontSize: 14.5,
                lineHeight: 1.55, whiteSpace: 'pre-line',
              }}
            >
              {msg.text}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder='Try: Spent $45 on lunch at Starbucks'
          style={{
            flex: 1, border: '1px solid var(--ink)', borderRadius: 2, padding: '10px 14px',
            fontSize: 15, background: 'transparent', color: 'var(--ink)',
          }}
        />
        <button
          onClick={handleSend}
          style={{
            background: 'var(--ink)', color: 'var(--paper)', border: 'none', borderRadius: 2,
            padding: '10px 22px', fontSize: 14, cursor: 'pointer',
          }}
        >
          Send →
        </button>
        <button
          onClick={handleReset}
          style={{
            background: 'transparent', color: 'var(--ink)', border: '1px solid var(--ink)',
            borderRadius: 2, padding: '10px 16px', fontSize: 14, cursor: 'pointer',
          }}
        >
          {t('common.demo_reset')}
        </button>
      </div>

      {/* Ledger */}
      <h2 style={{ fontSize: 22, fontWeight: 500, marginTop: 40 }}>{t('common.demo_sandbox_ledger')}</h2>
      <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginTop: 6 }}>
        {expenses.length} expenses · {fmt(grand)} total · fictional data
      </p>
      <div style={{ marginTop: 12, borderTop: '1px solid var(--rule)' }}>
        {expenses.map((e) => (
          <div
            key={e.id}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              padding: '10px 0', borderBottom: '1px solid var(--rule)', fontSize: 14.5,
            }}
          >
            <div>
              <span style={{ fontWeight: e.source === 'you' ? 600 : 400 }}>{e.description}</span>
              <span style={{ color: 'var(--muted)', fontSize: 12.5, marginLeft: 10 }}>
                {e.category} · {e.date}{e.source === 'you' ? ' · you' : ''}
              </span>
            </div>
            <div style={{ fontFamily: 'var(--font-num, monospace)' }}>{fmt(e.amountCents)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
