'use client';

import React from 'react';
import { tokens } from './tokens';

/**
 * A static placeholder block. Deliberately not animated: inline styles can't
 * declare keyframes, and a still block also satisfies prefers-reduced-motion.
 */
export function Skeleton({ width = '100%', height = 16, radius = tokens.radius.sm }: { width?: number | string; height?: number | string; radius?: number }) {
  return (
    <div
      data-skeleton
      aria-hidden="true"
      style={{ width, height, borderRadius: radius, background: tokens.color.mutedBg }}
    />
  );
}
