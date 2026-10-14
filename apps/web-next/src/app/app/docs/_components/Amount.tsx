'use client';

import React from 'react';
import { Money } from '../../_kit';

/**
 * Money in the tenant currency, or the kit's labelled dash until the currency
 * is known. Never a guessed '$' and never a "0.00" that reads as a real figure.
 */
export function Amount({ cents, currency }: { cents: number; currency: string | null }) {
  return <Money cents={currency ? cents : null} currency={currency ?? ''} />;
}
