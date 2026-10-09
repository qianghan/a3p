'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { useT } from '@/hooks/use-t';
import { isPdfUrl } from '../../_lib/format';
import { useOnlineStatus } from '../../_lib/useOnlineStatus';
import { EmptyState, buttonStyle, tokens } from '../../_kit';
import { PinchZoomImage } from './PinchZoomImage';

/**
 * Only http(s) (or a same-origin path) is ever put in an href / src. A receipt URL is server data, and a
 * `javascript:` URL in an <a href> would run on tap. Anything else is shown as "no receipt".
 */
export function safeReceiptUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, 'https://placeholder.invalid');
    return u.protocol === 'https:' || u.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * The receipt, three ways: a PDF is a link out, an image is the pinch-zoom viewer, nothing is a plain tile.
 *
 * PinchZoomImage has no onError of its own, so a failed load (offline with nothing cached, a deleted blob, a
 * revoked URL) would leave an empty bordered box. The wrapper's onError sees the image's failure (React delivers
 * it to ancestors); an image that had already failed by mount is caught by `complete && naturalWidth === 0`.
 * The failed state says so and offers Retry, which remounts the image.
 */
export function ReceiptPanel({ url }: { url: string | null }) {
  const t = useT();
  const safe = safeReceiptUrl(url);
  if (!safe) {
    return (
      <div data-testid="no-receipt-tile" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: tokens.space.sm, minHeight: 96, borderRadius: tokens.radius.md, border: `1px dashed ${tokens.color.border}`, color: tokens.color.muted }}>
        <ImageOff aria-hidden="true" style={{ width: 20, height: 20 }} />
        <span>{t('mobile.docs.no_receipt_tile')}</span>
      </div>
    );
  }
  if (isPdfUrl(safe)) {
    return (
      <a href={safe} target="_blank" rel="noopener noreferrer" style={{ ...buttonStyle('secondary'), width: '100%', boxSizing: 'border-box' }}>
        {t('mobile.docs.open_pdf')}
      </a>
    );
  }
  return <ReceiptImage src={safe} />;
}

function ReceiptImage({ src }: { src: string }) {
  const t = useT();
  const online = useOnlineStatus();
  const boxRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // A load that had already failed before React could see an event for it (a cached failure).
  useEffect(() => {
    setFailed(false);
    const img = boxRef.current?.querySelector('img');
    if (img && img.getAttribute('src') && img.complete && img.naturalWidth === 0) setFailed(true);
  }, [src, attempt]);

  // The image's `error` event does not bubble in the DOM, but React delivers it to an ancestor's onError, and
  // attaches that listener while committing the <img> — so there is no window in which a failure can be missed.
  const onImageError = (e: React.SyntheticEvent) => {
    if (e.target instanceof HTMLImageElement) setFailed(true);
  };
  const retryLocked = !online;
  const retry = () => {
    if (retryLocked) return;
    // The Retry button is replaced by the image: keep focus on a stable element instead of <body>.
    boxRef.current?.focus();
    setFailed(false);
    setAttempt((n) => n + 1);
  };

  // Coming back online is the one moment a retry is certain to be wanted.
  const wasOnline = useRef(online);
  const failedNow = useRef(failed);
  failedNow.current = failed;
  useEffect(() => {
    if (online && !wasOnline.current && failedNow.current) {
      setFailed(false);
      setAttempt((n) => n + 1);
    }
    wasOnline.current = online;
  }, [online]);

  return (
    <div ref={boxRef} tabIndex={-1} onError={onImageError} style={{ outline: 'none' }}>
      {failed ? (
        <div role="alert" data-testid="receipt-failed">
          <EmptyState
            title={t('mobile.docs.image_failed')}
            body={online ? undefined : t('mobile.docs.image_offline')}
            icon={<ImageOff width={24} height={24} />}
          >
            <div>
              <button
                type="button"
                style={buttonStyle('secondary', retryLocked)}
                aria-disabled={retryLocked || undefined}
                onClick={retry}
              >
                {t('mobile.docs.retry')}
              </button>
            </div>
          </EmptyState>
        </div>
      ) : (
        <PinchZoomImage key={src} src={src} alt={t('mobile.docs.receipt_alt')} hint={t('mobile.docs.zoom_hint')} />
      )}
    </div>
  );
}
