'use client';

import React from 'react';
import Link from 'next/link';
import type { TFn } from '@/hooks/use-t';
import { MessageBody } from './MessageBody';
import { useTenantMoney } from '../_lib/use-tenant-money';
import type { BotItem, PlanState, ReceiptItem, UserItem } from '../_lib/chat-reducer';
import type { ChatPlanStep } from '@/app/app/_lib/api';
import { tokens } from '@/app/app/_kit/tokens';

const TAP = 44;
// CSS, not copy: kept out of JSX so the English-string guard doesn't read it as text.
export const DOT_KEYFRAMES = '@keyframes abChatDot{0%,80%,100%{opacity:.25}40%{opacity:1}}@media (prefers-reduced-motion: reduce){[data-chat-dot]{animation:none !important;opacity:.6}}';
const bubble: React.CSSProperties = {
  padding: '10px 12px', borderRadius: 16, fontSize: 15, lineHeight: 1.45, overflowWrap: 'anywhere',
};
const muted: React.CSSProperties = { fontSize: 13, color: 'hsl(var(--muted-foreground))' };
const outlineBtn: React.CSSProperties = {
  minHeight: TAP, minWidth: TAP, padding: '0 14px', borderRadius: 12, fontSize: 14, fontWeight: 500,
  border: '1px solid hsl(var(--border))', background: 'hsl(var(--background))', color: 'hsl(var(--foreground))',
};
const solidBtn: React.CSSProperties = {
  ...outlineBtn, border: '1px solid hsl(var(--foreground))',
  background: 'hsl(var(--foreground))', color: 'hsl(var(--background))',
};
const chip: React.CSSProperties = {
  minHeight: TAP, padding: '0 14px', borderRadius: 22, fontSize: 14,
  border: '1px solid hsl(var(--border))', background: 'hsl(var(--muted))', color: 'hsl(var(--foreground))',
};

export function UserBubble({ item, t, onRetry, retryDisabled }: {
  item: UserItem; t: TFn; onRetry: (item: UserItem) => void; retryDisabled: boolean;
}) {
  return (
    <div data-testid="chat-bubble-user" data-status={item.status}
      style={{ alignSelf: 'flex-end', maxWidth: '85%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <div style={{
        ...bubble, whiteSpace: 'pre-wrap', background: tokens.color.primarySoft,
        color: 'hsl(var(--foreground))', opacity: item.status === 'sending' ? 0.7 : 1,
      }}>
        {item.text}
      </div>
      {item.status === 'failed' && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'hsl(var(--foreground))' }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, background: 'hsl(var(--destructive))' }} />
          <span>{item.failure === 'offline' ? t('mobile.chat.not_sent_offline') : t('mobile.chat.not_sent')}</span>
          <button type="button" data-testid="chat-retry" onClick={() => onRetry(item)} disabled={retryDisabled} style={outlineBtn}>
            {t('mobile.chat.retry')}
          </button>
        </div>
      )}
    </div>
  );
}

export function PlanCard({ steps, state, pending, t, disabled, onProceed, onCancel }: {
  steps: ChatPlanStep[]; state: PlanState; pending: boolean; t: TFn; disabled: boolean;
  onProceed: () => void; onCancel: () => void;
}) {
  return (
    <div data-testid={pending ? 'chat-plan-pending' : 'chat-plan-card'} data-state={state}
      style={{ marginTop: 8, padding: 10, borderRadius: 12, border: '1px solid hsl(var(--border))', background: 'hsl(var(--background))' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
        {pending ? t('mobile.chat.pending_title') : t('mobile.chat.plan_title')}
      </div>
      {!pending && steps.length > 0 && (
        <ol style={{ margin: '0 0 8px', paddingLeft: 20, fontSize: 14 }}>
          {steps.map((s, i) => <li key={s.id || i}>{s.description}</li>)}
        </ol>
      )}
      {state === 'open' && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" data-testid="chat-plan-proceed" disabled={disabled} onClick={onProceed} style={solidBtn}>
            {t('mobile.chat.proceed')}
          </button>
          <button type="button" data-testid="chat-plan-cancel" disabled={disabled} onClick={onCancel} style={outlineBtn}>
            {t('mobile.chat.cancel')}
          </button>
        </div>
      )}
      {(state === 'proceeding' || state === 'cancelling') && <div role="status" style={muted}>{t('mobile.chat.plan_working')}</div>}
      {state === 'done' && <div style={muted}>{t('mobile.chat.plan_resolved')}</div>}
    </div>
  );
}

export function SuggestionChips({ items, onPick, disabled, testId }: {
  items: string[]; onPick: (text: string) => void; disabled: boolean; testId: 'chat-suggestion' | 'chat-starter';
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {items.map((s) => (
        <button key={s} type="button" data-testid={testId} disabled={disabled} onClick={() => onPick(s)} style={chip}>
          {s}
        </button>
      ))}
    </div>
  );
}

export function BotBubble({ item, t, busy, sendBlocked, onProceed, onCancel, onUndo, onSuggestion }: {
  item: BotItem; t: TFn; busy: boolean; sendBlocked: boolean;
  onProceed: (item: BotItem) => void; onCancel: (item: BotItem) => void;
  onUndo: (item: BotItem) => void; onSuggestion: (text: string) => void;
}) {
  return (
    <div data-testid="chat-bubble-bot" style={{ alignSelf: 'flex-start', maxWidth: '88%', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ ...bubble, background: 'hsl(var(--card))', color: 'hsl(var(--foreground))', border: '1px solid hsl(var(--border))' }}>
        {item.errorKey === 'action_failed'
          ? <span role="alert">{t('mobile.chat.action_failed')}</span>
          : <MessageBody text={item.text} />}
        {item.planState && (item.plan || item.pendingFromHistory) && (
          <PlanCard
            steps={item.plan?.steps ?? []}
            state={item.planState}
            pending={item.pendingFromHistory}
            t={t}
            disabled={busy}
            onProceed={() => onProceed(item)}
            onCancel={() => onCancel(item)}
          />
        )}
      </div>
      {item.undoAvailable && (
        <button type="button" data-testid="chat-undo" disabled={busy} onClick={() => onUndo(item)} style={{ ...outlineBtn, alignSelf: 'flex-start' }}>
          {t('mobile.chat.undo')}
        </button>
      )}
      {item.suggestions.length > 0 && (
        <SuggestionChips items={item.suggestions} onPick={onSuggestion} disabled={busy || sendBlocked} testId="chat-suggestion" />
      )}
    </div>
  );
}

export function TypingIndicator({ label }: { label: string }) {
  return (
    <div data-testid="chat-typing" role="status" aria-label={label}
      style={{ alignSelf: 'flex-start', display: 'flex', gap: 4, padding: '12px 14px', borderRadius: 16, background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}>
      <style>{DOT_KEYFRAMES}</style>
      {[0, 1, 2].map((i) => (
        <span key={i} aria-hidden data-chat-dot style={{
          width: 7, height: 7, borderRadius: 4, background: 'hsl(var(--muted-foreground))',
          animation: `abChatDot 1.2s ${i * 0.2}s infinite ease-in-out`,
        }} />
      ))}
    </div>
  );
}

export function RateLimitNotice({ t, message, seconds }: { t: TFn; message: string | null; seconds: number }) {
  return (
    <div data-testid="chat-ratelimit" role="status" aria-live="polite"
      style={{ margin: '0 12px 8px', padding: '8px 12px', borderRadius: 12, fontSize: 13, background: tokens.color.warnSoft, color: 'hsl(var(--foreground))' }}>
      <div>{message ?? t('mobile.chat.rate_limited', { seconds })}</div>
      <div style={muted}>{t('mobile.chat.rate_limited_wait', { seconds })}</div>
    </div>
  );
}

export function ReceiptCard({ item, t, onRetry }: { item: ReceiptItem; t: TFn; onRetry: (item: ReceiptItem) => void }) {
  const money = useTenantMoney();
  const box: React.CSSProperties = {
    alignSelf: 'flex-end', maxWidth: '85%', padding: 12, borderRadius: 16, fontSize: 14,
    border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))', color: 'hsl(var(--foreground))',
    display: 'flex', flexDirection: 'column', gap: 6,
  };
  if (item.status === 'uploading') {
    return <div data-testid="chat-receipt" data-status="uploading" role="status" style={box}>{t('mobile.chat.receipt_uploading')}</div>;
  }
  if (item.status === 'failed' || !item.result) {
    return (
      <div data-testid="chat-receipt" data-status="failed" role="alert" style={box}>
        <span>{t('mobile.chat.receipt_failed')}</span>
        <button type="button" data-testid="chat-receipt-retry" onClick={() => onRetry(item)} style={{ ...outlineBtn, alignSelf: 'flex-start' }}>
          {t('mobile.chat.retry')}
        </button>
      </div>
    );
  }
  const { doc, duplicate } = item.result;
  const label = duplicate
    ? t('mobile.chat.receipt_duplicate')
    : doc.status === 'pending_review'
      ? t('mobile.chat.receipt_needs_review')
      : t('mobile.chat.receipt_saved');
  return (
    <div data-testid="chat-receipt" data-status="done" style={box}>
      <strong>{label}</strong>
      <span>
        {doc.vendorName ? `${doc.vendorName} · ` : ''}
        {doc.amountCents > 0 ? money(doc.amountCents) : t('mobile.chat.unreadable_amount')}
      </span>
      <Link href={`/app/docs/${doc.id}`} data-testid="chat-receipt-open"
        style={{ ...outlineBtn, display: 'inline-flex', alignItems: 'center', alignSelf: 'flex-start', textDecoration: 'none' }}>
        {t('mobile.chat.receipt_open')}
      </Link>
    </div>
  );
}
