'use client';

import React from 'react';
import { tokens } from './tokens';

export interface EmptyStateProps {
  title: string;
  body?: string;
  icon?: React.ReactNode;
  children?: React.ReactNode;
}

export function EmptyState({ title, body, icon, children }: EmptyStateProps) {
  return (
    <section style={{ display: 'grid', gap: tokens.space.md, padding: `${tokens.space.lg}px 0` }}>
      {icon && <div aria-hidden="true" style={{ color: tokens.color.muted }}>{icon}</div>}
      <h2 style={{ fontSize: tokens.font.lg, fontWeight: 600, margin: 0, color: tokens.color.fg }}>{title}</h2>
      {body && <p style={{ fontSize: tokens.font.md, lineHeight: 1.5, margin: 0, color: tokens.color.muted }}>{body}</p>}
      {children}
    </section>
  );
}
