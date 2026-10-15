'use client';

import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useT } from '@/hooks/use-t';
import { loadChatHistory, sendChat, uploadReceipt } from '@/app/app/_lib/api';
import { compressImage } from '@/app/app/_lib/image';
import { useKeyboardInset } from '@/app/app/_lib/useKeyboardInset';
import { useStickToBottom } from '@/app/app/_lib/useStickToBottom';
import {
  chatReducer, initialChatState, classifyFailure, retryAfterFrom, serverMessage,
  type BotItem, type ReceiptItem, type UserItem,
} from './_lib/chat-reducer';
import {
  BotBubble, ReceiptCard, RateLimitNotice, SuggestionChips, TypingIndicator, UserBubble,
} from './_components/ChatParts';
import { Composer } from './_components/Composer';

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
const isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);
const TABBAR_FALLBACK_PX = 64;

export default function MobileChat() {
  const t = useT();
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [online, setOnline] = useState(true);
  const [topPx, setTopPx] = useState<number | null>(null);
  const [tabbarPx, setTabbarPx] = useState(TABBAR_FALLBACK_PX);
  const files = useRef(new Map<string, File>());
  const listRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  // /app/chat?topic=... arrives from Home alerts that have no screen of their own (tax deadline, bill due).
  // Prefill the question; never send it, and never overwrite what the user already typed.
  useEffect(() => {
    try {
      const topic = new URLSearchParams(window.location.search).get('topic');
      const text =
        topic === 'tax_deadline' ? t('mobile.chat.topic_tax_deadline')
        : topic === 'bill_due' ? t('mobile.chat.topic_bill_due')
        : null;
      if (text) setDraft((d) => d || text);
    } catch {
      /* no window, or blocked: the composer simply stays empty */
    }
    // run once on mount; `t` is stable for the session language
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const historyStarted = useRef(false);
  const frame = useKeyboardInset();
  const { hasUnseen, scrollToBottom } = useStickToBottom(listRef, `${state.items.length}:${state.busy}:${state.history}`);

  // ── History: the active web thread, oldest-first (C4 loadChatHistory). ──
  const loadHistory = useCallback(async () => {
    dispatch({ type: 'history_loading' });
    try {
      const turns = await loadChatHistory();
      dispatch({ type: 'history_loaded', turns, now: Date.now() });
    } catch {
      dispatch({ type: 'history_failed' });
    }
  }, []);
  useEffect(() => {
    if (historyStarted.current) return; // StrictMode double-mount must not load twice
    historyStarted.current = true;
    void loadHistory();
  }, [loadHistory]);

  // ── Connectivity ──
  useEffect(() => {
    setOnline(isOnline());
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  // ── 429 countdown ──
  useEffect(() => {
    const until = state.rateLimitedUntil;
    if (until === null) return;
    const tick = () => {
      const n = Date.now();
      setNow(n);
      if (n >= until) dispatch({ type: 'rate_limit_cleared' });
    };
    tick();
    const h = window.setInterval(tick, 250);
    return () => window.clearInterval(h);
  }, [state.rateLimitedUntil]);
  const rateLimited = state.rateLimitedUntil !== null && now < state.rateLimitedUntil;
  const secondsLeft = rateLimited ? Math.max(1, Math.ceil((state.rateLimitedUntil! - now) / 1000)) : 0;

  // ── Layout: fixed panel between the shell header and the tab bar / keyboard ──
  useEffect(() => {
    const measure = () => {
      const a = anchorRef.current;
      if (a) setTopPx(Math.max(0, Math.round(a.getBoundingClientRect().top)));
      const bar = document.querySelector('[data-testid="tabbar"]');
      setTabbarPx(bar ? Math.round(bar.getBoundingClientRect().height) || TABBAR_FALLBACK_PX : TABBAR_FALLBACK_PX);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  const keyboardOpen = frame.keyboardPx > 0;
  const panelStyle: React.CSSProperties =
    topPx === null
      ? { display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 140px)' }
      : {
          position: 'fixed', left: 0, right: 0,
          top: topPx + frame.offsetTop,
          bottom: keyboardOpen ? frame.keyboardPx : tabbarPx,
          display: 'flex', flexDirection: 'column',
        };

  // ── Sending ──
  const performSend = useCallback(async (userId: string, text: string) => {
    try {
      const reply = await sendChat({ text });
      dispatch({ type: 'reply', userId, replyId: newId(), reply });
    } catch (err) {
      const failure = classifyFailure(err, isOnline());
      if (failure === 'rate_limited') {
        dispatch({ type: 'rate_limited', until: Date.now() + retryAfterFrom(err), message: serverMessage(err) });
      }
      dispatch({ type: 'send_failed', id: userId, failure });
    }
  }, []);

  const sendText = useCallback((raw: string) => {
    const text = raw.trim();
    if (!text || state.busy || rateLimited) return;
    const id = newId();
    dispatch({ type: 'send_started', id, text });
    setDraft('');
    scrollToBottom();
    void performSend(id, text);
  }, [state.busy, rateLimited, performSend, scrollToBottom]);

  const retry = useCallback((item: UserItem) => {
    if (state.busy || rateLimited) return;
    dispatch({ type: 'retry_started', id: item.id });
    void performSend(item.id, item.text);
  }, [state.busy, rateLimited, performSend]);

  // Session actions are exempt from the rate limiter server-side: allowed during a countdown.
  const sessionAction = useCallback(async (bot: BotItem, action: 'confirm' | 'cancel') => {
    if (state.busy) return;
    dispatch({ type: 'action_started', botId: bot.id, action });
    try {
      const reply = await sendChat({ sessionAction: action });
      dispatch({ type: 'reply', userId: null, replyId: newId(), reply });
    } catch {
      dispatch({ type: 'action_failed', botId: bot.id, errorId: newId(), restoreUndo: false });
    }
  }, [state.busy]);

  const undo = useCallback(async (bot: BotItem) => {
    if (state.busy) return;
    dispatch({ type: 'undo_started', botId: bot.id });
    try {
      const reply = await sendChat({ sessionAction: 'undo' });
      dispatch({ type: 'reply', userId: null, replyId: newId(), reply });
    } catch {
      dispatch({ type: 'action_failed', botId: bot.id, errorId: newId(), restoreUndo: true });
    }
  }, [state.busy]);

  // ── Photo → from-receipt (D1). Same idempotencyKey on retry = never two expenses. ──
  const startReceipt = useCallback(async (id: string, idempotencyKey: string, original: File) => {
    files.current.set(id, original);
    dispatch({ type: 'receipt_started', id, idempotencyKey });
    scrollToBottom();
    try {
      let upload: File = original;
      try { upload = await compressImage(original); } catch { upload = original; }
      const result = await uploadReceipt(upload, { idempotencyKey });
      files.current.delete(id);
      dispatch({ type: 'receipt_done', id, result });
    } catch {
      dispatch({ type: 'receipt_failed', id });
    }
  }, [scrollToBottom]);
  const onPhoto = useCallback((file: File) => { void startReceipt(newId(), newId(), file); }, [startReceipt]);
  const retryReceipt = useCallback((item: ReceiptItem) => {
    const f = files.current.get(item.id);
    if (f) void startReceipt(item.id, item.idempotencyKey, f);
  }, [startReceipt]);

  const starters = [
    t('mobile.chat.starter_briefing'),
    t('mobile.chat.starter_spend'),
    t('mobile.chat.starter_log'),
  ];

  return (
    <>
      <div ref={anchorRef} aria-hidden style={{ height: 0 }} />
      <section data-testid="chat-screen" aria-labelledby="chat-title" style={{ ...panelStyle, background: 'hsl(var(--background))', color: 'hsl(var(--foreground))' }}>
        <header data-testid="chat-header" style={{ padding: '10px 16px', borderBottom: '1px solid hsl(var(--border))' }}>
          <h1 id="chat-title" style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>{t('mobile.chat.title')}</h1>
          <p style={{ fontSize: 13, margin: 0, color: 'hsl(var(--muted-foreground))' }}>{t('mobile.chat.subtitle')}</p>
        </header>

        {!online && (
          <div data-testid="chat-offline" role="status" style={{ padding: '8px 16px', fontSize: 13, background: 'hsl(var(--muted))' }}>
            {t('mobile.chat.offline_banner')}
          </div>
        )}

        <div ref={listRef} data-testid="chat-list" role="log" aria-live="polite"
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 12px 16px', display: 'flex', flexDirection: 'column', gap: 10, overscrollBehavior: 'contain' }}>
          {state.history === 'loading' && (
            <div data-testid="chat-history-loading" role="status" style={{ alignSelf: 'center', fontSize: 14, color: 'hsl(var(--muted-foreground))' }}>
              {t('mobile.chat.history_loading')}
            </div>
          )}
          {state.history === 'error' && (
            <div data-testid="chat-history-error" role="alert" style={{ alignSelf: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, fontSize: 14 }}>
              <span>{t('mobile.chat.history_error')}</span>
              <button type="button" data-testid="chat-history-retry" onClick={() => void loadHistory()}
                style={{ minHeight: 44, padding: '0 16px', borderRadius: 12, border: '1px solid hsl(var(--border))', background: 'hsl(var(--background))', color: 'hsl(var(--foreground))' }}>
                {t('mobile.chat.retry')}
              </button>
            </div>
          )}
          {state.history === 'ready' && state.items.length === 0 && (
            <div data-testid="chat-empty" style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
              <p style={{ fontSize: 15, fontWeight: 500, margin: 0 }}>{t('mobile.chat.empty_title')}</p>
              <SuggestionChips items={starters} onPick={sendText} disabled={state.busy || rateLimited} testId="chat-starter" />
            </div>
          )}

          {state.items.map((item) => {
            if (item.kind === 'user') {
              return <UserBubble key={item.id} item={item} t={t} onRetry={retry} retryDisabled={state.busy || rateLimited} />;
            }
            if (item.kind === 'receipt') {
              return <ReceiptCard key={item.id} item={item} t={t} onRetry={retryReceipt} />;
            }
            return (
              <BotBubble key={item.id} item={item} t={t} busy={state.busy} sendBlocked={rateLimited}
                onProceed={(b) => void sessionAction(b, 'confirm')}
                onCancel={(b) => void sessionAction(b, 'cancel')}
                onUndo={(b) => void undo(b)}
                onSuggestion={sendText} />
            );
          })}

          {state.busy && <TypingIndicator label={t('mobile.chat.typing')} />}
        </div>

        {hasUnseen && (
          <button type="button" data-testid="chat-new-messages" onClick={scrollToBottom}
            style={{ alignSelf: 'center', marginTop: -52, marginBottom: 8, minHeight: 44, padding: '0 16px', borderRadius: 22, border: '1px solid hsl(var(--border))', background: 'hsl(var(--card))', color: 'hsl(var(--foreground))', position: 'relative', zIndex: 1 }}>
            {t('mobile.chat.new_messages')}
          </button>
        )}

        {rateLimited && <RateLimitNotice t={t} message={state.rateLimitMessage} seconds={secondsLeft} />}

        <Composer
          t={t}
          value={draft}
          onChange={setDraft}
          onSend={() => sendText(draft)}
          sendDisabled={!draft.trim() || state.busy || rateLimited}
          onPhoto={onPhoto}
        />
      </section>
    </>
  );
}
