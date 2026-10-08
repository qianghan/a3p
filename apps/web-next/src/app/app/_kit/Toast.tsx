'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/hooks/use-t';
import { tokens, toneColors } from './tokens';

export type ToastTone = 'neutral' | 'good' | 'critical';

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

export interface ToastApi {
  show: (message: string, opts?: { tone?: ToastTone; durationMs?: number }) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const NOOP: ToastApi = { show: () => {} };
const MAX_VISIBLE = 3;

/** Outside a ToastHost this is a no-op: a missing host must never crash a screen. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}

export function toastStyle(tone: ToastTone): React.CSSProperties {
  const c = toneColors(tone);
  return {
    background: tokens.color.card,
    color: tokens.color.fg,
    border: `1px solid ${tokens.color.border}`,
    borderLeft: `4px solid ${c.accent}`,
    borderRadius: tokens.radius.md,
    padding: `${tokens.space.md}px ${tokens.space.lg}px`,
    fontSize: tokens.font.md,
    boxShadow: `0 6px 20px ${tokens.color.scrim}`,
  };
}

export function Toast({ message, tone }: { message: string; tone: ToastTone }) {
  return (
    <div data-tone={tone} style={toastStyle(tone)}>
      {message}
    </div>
  );
}

export function ToastHost({ children }: { children: React.ReactNode }) {
  const t = useT();
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const show = useCallback<ToastApi['show']>((message, opts) => {
    nextId.current += 1;
    const id = nextId.current;
    setItems((list) => [...list, { id, message, tone: opts?.tone ?? 'neutral' }].slice(-MAX_VISIBLE));
    const timer = setTimeout(() => {
      setItems((list) => list.filter((i) => i.id !== id));
      timers.current.delete(id);
    }, opts?.durationMs ?? 3500);
    timers.current.set(id, timer);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        aria-label={t('mobile.kit.notifications')}
        style={{
          position: 'fixed',
          left: tokens.space.lg,
          right: tokens.space.lg,
          bottom: `calc(${tokens.tabBarHeight + tokens.space.xl}px + env(safe-area-inset-bottom))`,
          display: 'grid',
          gap: tokens.space.sm,
          zIndex: 60,
          pointerEvents: 'none',
        }}
      >
        {items.map((i) => (
          <Toast key={i.id} message={i.message} tone={i.tone} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
