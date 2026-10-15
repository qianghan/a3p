import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { withShell } from './chat-test-utils';
import {
  UserBubble, BotBubble, SuggestionChips, TypingIndicator, ReceiptCard, RateLimitNotice,
} from '../../../app/app/chat/_components/ChatParts';
import { Composer } from '../../../app/app/chat/_components/Composer';
import { useT } from '../../../hooks/use-t';
import type { BotItem, ReceiptItem, UserItem } from '../../../app/app/chat/_lib/chat-reducer';
import type { FromReceiptResult } from '../../../lib/mobile/types';

function T({ children }: { children: (t: ReturnType<typeof useT>) => React.ReactNode }) {
  const t = useT();
  return <>{children(t)}</>;
}
const baseBot: BotItem = {
  id: 'b1', kind: 'bot', text: '**Hi** there', plan: null, pendingFromHistory: false, planState: null,
  suggestions: [], undoAvailable: false, errorKey: null,
};
const noop = () => {};

describe('UserBubble', () => {
  it('failed → shows Not sent + Retry and keeps the text', () => {
    const onRetry = vi.fn();
    const item: UserItem = { id: 'u1', kind: 'user', text: 'keep me', status: 'failed', failure: 'server' };
    render(withShell(<T>{(t) => <UserBubble item={item} t={t} onRetry={onRetry} retryDisabled={false} />}</T>));
    expect(screen.getByTestId('chat-bubble-user')).toHaveTextContent('keep me');
    expect(screen.getByText('Not sent.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chat-retry'));
    expect(onRetry).toHaveBeenCalledWith(item);
  });
  it('offline failure uses the offline copy', () => {
    const item: UserItem = { id: 'u1', kind: 'user', text: 'x', status: 'failed', failure: 'offline' };
    render(withShell(<T>{(t) => <UserBubble item={item} t={t} onRetry={noop} retryDisabled={false} />}</T>));
    expect(screen.getByText("You're offline — not sent.")).toBeInTheDocument();
  });
});

describe('BotBubble', () => {
  const handlers = { onProceed: vi.fn(), onCancel: vi.fn(), onUndo: vi.fn(), onSuggestion: vi.fn() };
  it('formats text through MessageBody', () => {
    render(withShell(<T>{(t) => <BotBubble item={baseBot} t={t} busy={false} sendBlocked={false} {...handlers} />}</T>));
    expect(screen.getByText('Hi').tagName).toBe('STRONG');
  });
  it('open plan → steps + Proceed/Cancel wired', () => {
    const item: BotItem = { ...baseBot, plan: { steps: [{ id: 's1', description: 'Edit expense last' }] }, planState: 'open' };
    render(withShell(<T>{(t) => <BotBubble item={item} t={t} busy={false} sendBlocked={false} {...handlers} />}</T>));
    expect(screen.getByTestId('chat-plan-card')).toHaveTextContent("I'd like to do this:");
    expect(screen.getByTestId('chat-plan-card')).toHaveTextContent('Edit expense last');
    fireEvent.click(screen.getByTestId('chat-plan-proceed'));
    fireEvent.click(screen.getByTestId('chat-plan-cancel'));
    expect(handlers.onProceed).toHaveBeenCalledWith(item);
    expect(handlers.onCancel).toHaveBeenCalledWith(item);
  });
  it('proceeding → no buttons, Working…', () => {
    const item: BotItem = { ...baseBot, plan: { steps: [] }, planState: 'proceeding' };
    render(withShell(<T>{(t) => <BotBubble item={item} t={t} busy sendBlocked={false} {...handlers} />}</T>));
    expect(screen.queryByTestId('chat-plan-proceed')).toBeNull();
    expect(screen.getByTestId('chat-plan-card')).toHaveTextContent('Working…');
  });
  it('pending-from-history → Pending action card, no steps list', () => {
    const item: BotItem = { ...baseBot, pendingFromHistory: true, planState: 'open' };
    render(withShell(<T>{(t) => <BotBubble item={item} t={t} busy={false} sendBlocked={false} {...handlers} />}</T>));
    expect(screen.getByTestId('chat-plan-pending')).toHaveTextContent('Pending action — waiting for your answer');
    expect(screen.getByTestId('chat-plan-proceed')).toBeEnabled();
  });
  it('undo + error rendering', () => {
    const item: BotItem = { ...baseBot, undoAvailable: true };
    render(withShell(<T>{(t) => <BotBubble item={item} t={t} busy={false} sendBlocked={false} {...handlers} />}</T>));
    fireEvent.click(screen.getByTestId('chat-undo'));
    expect(handlers.onUndo).toHaveBeenCalledWith(item);
  });
  it('errorKey renders localized error text, not the empty message', () => {
    const item: BotItem = { ...baseBot, text: '', errorKey: 'action_failed' };
    render(withShell(<T>{(t) => <BotBubble item={item} t={t} busy={false} sendBlocked={false} {...handlers} />}</T>));
    expect(screen.getByRole('alert')).toHaveTextContent("That didn't go through. Try again.");
  });
});

describe('SuggestionChips', () => {
  it('sends the chip text; disabled while blocked', () => {
    const onPick = vi.fn();
    const { rerender } = render(<SuggestionChips items={['Show my expenses']} onPick={onPick} disabled={false} testId="chat-suggestion" />);
    fireEvent.click(screen.getByTestId('chat-suggestion'));
    expect(onPick).toHaveBeenCalledWith('Show my expenses');
    rerender(<SuggestionChips items={['Show my expenses']} onPick={onPick} disabled testId="chat-suggestion" />);
    expect(screen.getByTestId('chat-suggestion')).toBeDisabled();
  });
});

describe('TypingIndicator / RateLimitNotice', () => {
  it('typing indicator is a labelled status', () => {
    render(<TypingIndicator label="Advisor is typing" />);
    expect(screen.getByRole('status', { name: 'Advisor is typing' })).toBeInTheDocument();
  });
  it('rate-limit notice shows the server message and the countdown', () => {
    render(withShell(<T>{(t) => <RateLimitNotice t={t} message="Slow down" seconds={4} />}</T>));
    expect(screen.getByTestId('chat-ratelimit')).toHaveTextContent('Slow down');
    expect(screen.getByTestId('chat-ratelimit')).toHaveTextContent('Send available in 4s');
  });
  it('rate-limit notice falls back to localized copy without a server message', () => {
    render(withShell(<T>{(t) => <RateLimitNotice t={t} message={null} seconds={9} />}</T>));
    expect(screen.getByTestId('chat-ratelimit')).toHaveTextContent("You're sending messages quickly. Try again in 9s.");
  });
});

describe('ReceiptCard', () => {
  const result = {
    doc: { id: 'doc1', amountCents: 1234, vendorName: 'Cafe Uno', status: 'confirmed' },
    duplicate: false,
    ocr: { amountCents: 1234, vendor: 'Cafe Uno', date: '2026-10-07' },
  } as unknown as FromReceiptResult;
  it('done → label, vendor, money in tenant currency, link to the viewer', () => {
    const item: ReceiptItem = { id: 'r1', kind: 'receipt', status: 'done', idempotencyKey: 'k', result };
    render(withShell(<T>{(t) => <ReceiptCard item={item} t={t} onRetry={noop} />}</T>));
    const card = screen.getByTestId('chat-receipt');
    expect(card).toHaveTextContent('Receipt saved');
    expect(card).toHaveTextContent('Cafe Uno');
    expect(card).toHaveTextContent('$12.34');
    expect(screen.getByTestId('chat-receipt-open')).toHaveAttribute('href', '/app/docs/doc1');
  });
  it('pending_review → needs review label; zero amount → unreadable', () => {
    const r = { ...result, doc: { ...(result.doc as object), amountCents: 0, status: 'pending_review' } } as unknown as FromReceiptResult;
    const item: ReceiptItem = { id: 'r1', kind: 'receipt', status: 'done', idempotencyKey: 'k', result: r };
    render(withShell(<T>{(t) => <ReceiptCard item={item} t={t} onRetry={noop} />}</T>));
    expect(screen.getByTestId('chat-receipt')).toHaveTextContent('Saved — needs your review');
    expect(screen.getByTestId('chat-receipt')).toHaveTextContent('Amount unreadable');
  });
  it('failed → retry callback', () => {
    const onRetry = vi.fn();
    const item: ReceiptItem = { id: 'r1', kind: 'receipt', status: 'failed', idempotencyKey: 'k', result: null };
    render(withShell(<T>{(t) => <ReceiptCard item={item} t={t} onRetry={onRetry} />}</T>));
    fireEvent.click(screen.getByTestId('chat-receipt-retry'));
    expect(onRetry).toHaveBeenCalledWith(item);
  });
});

describe('Composer', () => {
  function setup(sendDisabled = false) {
    const onSend = vi.fn();
    const onChange = vi.fn();
    const onPhoto = vi.fn();
    render(withShell(<T>{(t) => (
      <Composer t={t} value="hello" onChange={onChange} onSend={onSend} sendDisabled={sendDisabled} onPhoto={onPhoto} />
    )}</T>));
    return { onSend, onChange, onPhoto };
  }
  it('Enter sends, Shift+Enter does not, IME composition does not', () => {
    const { onSend } = setup();
    const input = screen.getByTestId('chat-input');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
  it('send button is labelled and respects sendDisabled', () => {
    setup(true);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });
  it('attach opens camera/library choices; a picked file goes to onPhoto', () => {
    const { onPhoto } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Attach a photo' }));
    expect(screen.getByTestId('chat-attach-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('chat-file-camera')).toHaveAttribute('capture', 'environment');
    const file = new File(['x'], 'r.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('chat-file-library'), { target: { files: [file] } });
    expect(onPhoto).toHaveBeenCalledWith(file);
    expect(screen.queryByTestId('chat-attach-sheet')).toBeNull();
  });
});
