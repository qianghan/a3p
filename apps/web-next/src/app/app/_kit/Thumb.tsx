'use client';

import React from 'react';
import Image from 'next/image';
import { FileText, ImageOff } from 'lucide-react';
import { useT } from '@/hooks/use-t';
import { tokens } from './tokens';

/** next.config.js remotePatterns allows **.vercel-storage.com; anything else bypasses the optimizer. */
export function isOptimizableHost(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.vercel-storage.com');
  } catch {
    return false;
  }
}

export function isPdfUrl(url: string): boolean {
  return /\.pdf($|[?#])/i.test(url);
}

export function Thumb({ src, alt, size = 56 }: { src: string | null; alt: string; size?: number }) {
  const t = useT();
  const box: React.CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    borderRadius: tokens.radius.sm,
    background: tokens.color.mutedBg,
    color: tokens.color.muted,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  };
  const icon = Math.round(size / 2.5);
  if (!src) {
    return (
      <div role="img" aria-label={t('mobile.kit.no_receipt')} style={box}>
        <ImageOff aria-hidden="true" width={icon} height={icon} />
      </div>
    );
  }
  if (isPdfUrl(src)) {
    return (
      <div role="img" aria-label={t('mobile.kit.pdf_receipt')} style={box}>
        <FileText aria-hidden="true" width={icon} height={icon} />
      </div>
    );
  }
  return (
    <div style={box}>
      <Image
        src={src}
        alt={alt}
        width={size}
        height={size}
        sizes={`${size}px`}
        loading="lazy"
        unoptimized={!isOptimizableHost(src)}
        style={{ objectFit: 'cover', width: size, height: size }}
      />
    </div>
  );
}
