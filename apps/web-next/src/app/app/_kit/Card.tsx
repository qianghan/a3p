'use client';

import React from 'react';
import { tokens } from './tokens';

export function cardStyle(extra?: React.CSSProperties): React.CSSProperties {
  return {
    background: tokens.color.card,
    color: tokens.color.cardFg,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.md,
    padding: tokens.space.lg,
    ...extra,
  };
}

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export function Card({ children, style, ...rest }: CardProps) {
  return (
    <div {...rest} style={cardStyle(style)}>
      {children}
    </div>
  );
}
