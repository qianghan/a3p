'use client';

import React from 'react';
import { buttonStyle, type ButtonVariant } from './styles';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', disabled, style, type, children, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      disabled={disabled}
      {...rest}
      style={{ ...buttonStyle(variant, Boolean(disabled)), ...style }}
    >
      {children}
    </button>
  );
}
