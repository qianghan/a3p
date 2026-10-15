'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Rule: follow new content only while the user is at (or near) the bottom. */
export const STICK_THRESHOLD_PX = 80;

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function isNearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = STICK_THRESHOLD_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

export function useStickToBottom(
  ref: RefObject<HTMLElement | null>,
  contentKey: unknown,
): { hasUnseen: boolean; scrollToBottom: () => void } {
  const stick = useRef(true);
  const [hasUnseen, setHasUnseen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = isNearBottom(el);
      if (stick.current) setHasUnseen(false);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref]);

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setHasUnseen(true);
  }, [ref, contentKey]);

  const scrollToBottom = useCallback(() => {
    stick.current = true;
    setHasUnseen(false);
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ref]);

  return { hasUnseen, scrollToBottom };
}
