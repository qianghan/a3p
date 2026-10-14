'use client';

import React, { useState } from 'react';
import Image from 'next/image';
import { FileText, Receipt } from 'lucide-react';
import { isPdfUrl } from '../../_lib/format';
import { tokens } from '../../_kit/tokens';
import { isOptimizableHost } from '../../_kit/Thumb';

/**
 * List thumbnail. Receipts are full-size public Blob photos (often 1-3 MB);
 * rendering them raw in a 100-row list is the render-blocking load the spec
 * forbids, so they go through the Next image optimizer at the displayed size.
 * Width/height are always fixed so rows never shift as images arrive.
 *
 * Hosts next.config.js does not allow (e.g. a non-Blob sourceUrl kept when no
 * Blob token is configured) skip the optimizer and render the plain lazy
 * <img>: the optimizer would 400 them in production and throw at render in dev.
 */
export function DocThumb({ src, size, alt }: { src: string | null; size: number; alt: string }) {
  // Keyed by src so a recycled row that gets a different receipt retries the optimizer.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const box: React.CSSProperties = {
    width: size, height: size, flex: '0 0 auto', borderRadius: tokens.radius.sm, overflow: 'hidden',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: tokens.color.mutedBg, color: tokens.color.muted,
  };
  const icon = { width: Math.round(size * 0.42), height: Math.round(size * 0.42) };

  if (!src) {
    return <span style={box} aria-hidden="true" data-testid="doc-thumb-empty"><Receipt style={icon} /></span>;
  }
  if (isPdfUrl(src)) {
    return <span style={box} aria-hidden="true" data-testid="doc-thumb-pdf"><FileText style={icon} /></span>;
  }
  const plain = failedSrc === src || !isOptimizableHost(src);
  return (
    <span style={box}>
      {plain ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} width={size} height={size} loading="lazy" decoding="async"
          style={{ width: size, height: size, objectFit: 'cover' }} data-testid="doc-thumb-fallback" />
      ) : (
        <Image src={src} alt={alt} width={size} height={size} sizes={`${size}px`} quality={60} loading="lazy"
          style={{ width: size, height: size, objectFit: 'cover' }} onError={() => setFailedSrc(src)} data-testid="doc-thumb" />
      )}
    </span>
  );
}
