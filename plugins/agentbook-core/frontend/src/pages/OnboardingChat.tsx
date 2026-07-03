/**
 * Agent-driven onboarding (G-032 / PR 27).
 *
 * Replaces the 7-step traditional wizard at `/onboarding` with a
 * chat-style conversation. For an "agent-native" product, the front
 * door should look like the rest of the product — talking to the
 * agent — not a multi-page form.
 *
 * Implementation strategy: a scripted chat that reuses the chat-bubble
 * aesthetic (matches Chat.tsx from PR 11) but follows a deterministic
 * question sequence. Each step persists incrementally to the existing
 * /tenant-config + /onboarding/complete-step endpoints so we don't
 * have to rewrite the persistence layer.
 *
 * Why deterministic instead of LLM-driven: onboarding is a low-trust
 * moment — the user is brand-new and needs predictable progress.
 * Hallucinated questions or skipped steps here destroy first-impression
 * conversion. The chat-LIKE aesthetic gives the agent-first feel without
 * the agent-quality risk.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Send, CheckCircle, Bot, User } from 'lucide-react';

const API_BASE = '/api/v1/agentbook-core';

interface ChatMessage {
  role: 'agent' | 'user';
  text: string;
  suggestions?: { label: string; value: string }[];
  highlight?: boolean;
}

type StepId =
  | 'welcome'
  | 'business_type'
  | 'jurisdiction'
  | 'region'
  | 'currency'
  | 'accounts'
  | 'first_expense'
  | 'done';

interface OnboardingState {
  businessType?: string;
  jurisdiction?: string;
  region?: string;
  currency?: string;
}

const BUSINESS_TYPES = [
  { label: 'Freelancer', value: 'freelancer' },
  { label: 'Sole proprietor', value: 'sole_proprietor' },
  { label: 'Consultant', value: 'consultant' },
  { label: 'Contractor', value: 'contractor' },
  { label: 'Student', value: 'student' },
];

const JURISDICTIONS = [
  { label: '🇺🇸 United States', value: 'us', defaultCurrency: 'USD' },
  { label: '🇨🇦 Canada', value: 'ca', defaultCurrency: 'CAD' },
  { label: '🇬🇧 United Kingdom', value: 'uk', defaultCurrency: 'GBP' },
  { label: '🇦🇺 Australia', value: 'au', defaultCurrency: 'AUD' },
];

const CURRENCIES = [
  { label: 'USD ($)', value: 'USD' },
  { label: 'CAD ($)', value: 'CAD' },
  { label: 'GBP (£)', value: 'GBP' },
  { label: 'EUR (€)', value: 'EUR' },
  { label: 'AUD ($)', value: 'AUD' },
];

const SCRIPT: Record<StepId, (state: OnboardingState) => ChatMessage[]> = {
  welcome: () => [
    {
      role: 'agent',
      text:
        "Hi — I'm AgentBook. I'll get you set up in about 2 minutes. " +
        'You can chat with me from here on out: log expenses, send invoices, ask about your finances. ' +
        'Let me start with a few quick questions.',
    },
    {
      role: 'agent',
      text: 'What kind of work do you do?',
      suggestions: BUSINESS_TYPES,
    },
  ],
  business_type: () => [
    {
      role: 'agent',
      text: "Got it. Where are you based? (This sets your tax jurisdiction.)",
      suggestions: JURISDICTIONS,
    },
  ],
  jurisdiction: (state) => {
    const j = JURISDICTIONS.find((x) => x.value === state.jurisdiction);
    const subPrompt = state.jurisdiction === 'us'
      ? "What state? (Type the abbreviation, e.g. 'CA' or 'NY')"
      : state.jurisdiction === 'ca'
        ? "What province? (e.g. 'ON' or 'BC')"
        : 'What region or country code? (Optional — press skip to continue.)';
    return [
      { role: 'agent', text: `${j?.label ?? state.jurisdiction} — got it.` },
      { role: 'agent', text: subPrompt, suggestions: [{ label: 'Skip', value: '__skip__' }] },
    ];
  },
  region: (state) => {
    const j = JURISDICTIONS.find((x) => x.value === state.jurisdiction);
    const defaultCur = j?.defaultCurrency ?? 'USD';
    return [
      {
        role: 'agent',
        text: `Your books default to ${defaultCur}. Use a different currency?`,
        suggestions: [{ label: `Keep ${defaultCur}`, value: defaultCur }, ...CURRENCIES.filter((c) => c.value !== defaultCur)],
      },
    ];
  },
  currency: (state) => [
    {
      role: 'agent',
      text:
        state.businessType === 'student'
          ? "Great. I'll set up a few categories for you — things like tuition, textbooks, part-time job income, and scholarships. Takes one second, and there's nothing to fill in yourself."
          : "Great. I'll seed your chart of accounts now — that's the underlying structure that lets you run a P&L, balance sheet, and tax reports. Takes one second.",
      suggestions: [{ label: state.businessType === 'student' ? 'Set up my categories' : 'Set up accounts', value: 'seed' }],
    },
  ],
  accounts: (state) => [
    {
      role: 'agent',
      text:
        state.businessType === 'student'
          ? "Done. Last thing — want to log something to try it out? A campus job paycheck, a tutoring payment, or a textbook you bought all work."
          : "Accounts ready. Last thing — want to log your first expense to try it out? It's how you'll typically interact with me.",
      suggestions: [
        { label: 'Yes, log one now', value: 'try' },
        { label: 'Skip — go to chat', value: '__skip__' },
      ],
    },
  ],
  first_expense: (state) => [
    {
      role: 'agent',
      text:
        state.businessType === 'student'
          ? "Perfect — go to the chat (top of the page) and type something like 'log $40 textbooks' or drop a receipt photo. Come tax season, I'll also help you figure out things like whether a scholarship is taxable — no guessing required."
          : "Perfect — go to the chat (top of the page) and type something like 'log $5 coffee' or drop a receipt photo. I'll handle the rest.",
    },
    { role: 'agent', text: "Setup complete. Welcome to AgentBook!", highlight: true },
  ],
  done: () => [],
};

export const OnboardingChatPage: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [step, setStep] = useState<StepId>('welcome');
  const [state, setState] = useState<OnboardingState>({});
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Kick off the welcome script.
  useEffect(() => {
    setMessages(SCRIPT.welcome({}));
  }, []);

  // Auto-scroll to newest.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, submitting]);

  async function persistConfig(patch: Partial<OnboardingState>) {
    try {
      await fetch(`${API_BASE}/tenant-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } catch (err) {
      // Non-fatal — user can retry, completion endpoint catches incomplete state.
      console.warn('[onboarding] tenant-config save failed:', err);
    }
  }

  async function markStepComplete(stepId: string) {
    try {
      await fetch(`${API_BASE}/onboarding/complete-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepId }),
      });
    } catch {
      // Best-effort
    }
  }

  async function seedAccounts() {
    try {
      await fetch(`${API_BASE}/accounts/seed-jurisdiction`, { method: 'POST' });
    } catch (err) {
      console.warn('[onboarding] accounts seed failed:', err);
    }
  }

  async function handleAnswer(value: string, displayText?: string) {
    // Echo the user's pick into the transcript.
    setMessages((m) => [...m, { role: 'user', text: displayText ?? value }]);
    setInput('');
    setSubmitting(true);

    try {
      let nextState = state;
      let nextStep: StepId = step;

      switch (step) {
        case 'welcome': {
          nextState = { ...state, businessType: value };
          await persistConfig({ businessType: value });
          await markStepComplete('business_type');
          nextStep = 'business_type';
          break;
        }
        case 'business_type': {
          nextState = { ...state, jurisdiction: value };
          await persistConfig({ jurisdiction: value });
          await markStepComplete('jurisdiction');
          nextStep = 'jurisdiction';
          break;
        }
        case 'jurisdiction': {
          if (value !== '__skip__') {
            nextState = { ...state, region: value.toUpperCase() };
            await persistConfig({ region: value.toUpperCase() });
          }
          nextStep = 'region';
          break;
        }
        case 'region': {
          nextState = { ...state, currency: value };
          await persistConfig({ currency: value });
          await markStepComplete('currency');
          nextStep = 'currency';
          break;
        }
        case 'currency': {
          await seedAccounts();
          await markStepComplete('accounts');
          nextStep = 'accounts';
          break;
        }
        case 'accounts': {
          await markStepComplete('first_expense');
          nextStep = 'first_expense';
          break;
        }
        case 'first_expense': {
          await markStepComplete('done');
          nextStep = 'done';
          setCompleted(true);
          break;
        }
        case 'done':
          break;
      }

      setState(nextState);
      setStep(nextStep);
      if (nextStep !== 'done') {
        const next = SCRIPT[nextStep](nextState);
        // Stagger to feel less mechanical.
        for (let i = 0; i < next.length; i++) {
          await new Promise((r) => setTimeout(r, 250));
          setMessages((m) => [...m, next[i]]);
        }
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTextSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || submitting) return;
    const value = input.trim();
    // Free-text fallback — only meaningful for region step right now.
    await handleAnswer(value);
  }

  const lastMessage = messages[messages.length - 1];
  const suggestions = lastMessage?.suggestions ?? [];

  return (
    <div className="flex flex-col h-full max-h-screen">
      {/* Progress banner */}
      <div className="border-b border-border bg-card/50 px-4 py-3 text-center">
        <h1 className="text-sm font-medium text-muted-foreground">
          {completed ? 'Setup complete' : 'Welcome — 2-minute setup'}
        </h1>
      </div>

      {/* Message list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 max-w-2xl mx-auto w-full">
        <div className="space-y-4">
          {messages.map((m, i) => (
            <div
              key={i}
              className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}
            >
              <div
                className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                  m.role === 'user' ? 'bg-primary/10' : 'bg-muted'
                }`}
              >
                {m.role === 'user' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
              </div>
              <div
                className={`max-w-md p-3 rounded-2xl text-sm leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-primary text-primary-foreground rounded-br-sm'
                    : m.highlight
                      ? 'bg-green-500/10 border border-green-500/30 rounded-bl-sm'
                      : 'bg-card border border-border rounded-bl-sm'
                }`}
              >
                {m.highlight && <CheckCircle className="w-4 h-4 inline mr-1 text-green-600" />}
                {m.text}
              </div>
            </div>
          ))}
          {submitting && (
            <div className="flex gap-3">
              <div className="shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                <Bot className="w-4 h-4" />
              </div>
              <div className="p-3 text-muted-foreground text-sm">...</div>
            </div>
          )}
        </div>
      </div>

      {/* Suggestion buttons + input */}
      <div className="border-t border-border bg-card/30 px-4 py-3 max-w-2xl mx-auto w-full">
        {!completed && suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {suggestions.map((s) => (
              <button
                key={s.value}
                onClick={() => handleAnswer(s.value, s.label)}
                disabled={submitting}
                className="px-3 py-1.5 text-sm border border-border rounded-full hover:bg-muted disabled:opacity-50"
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        {!completed && (
          <form onSubmit={handleTextSubmit} className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Or type your answer..."
              disabled={submitting}
              className="flex-1 px-3 py-2 bg-background border border-border rounded-lg focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={submitting || !input.trim()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        )}
        {completed && (
          <div className="text-center">
            <a
              href="/agentbook/chat"
              className="inline-block px-4 py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:opacity-90"
            >
              Open chat
            </a>
          </div>
        )}
      </div>
    </div>
  );
};
