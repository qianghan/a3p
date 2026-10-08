import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ForwardView } from '../ForwardView';
import { withShell } from '../../../__tests__/i18n-harness';

/**
 * /dashboard/overview returns cashToday: null when the tenant has no cash or
 * bank account (cash is cash/bank only — receivables are not counted). The
 * headline must say "no figure", never "$0 today".
 */
describe('ForwardView', () => {
  it('shows the cash figure when there is one', () => {
    const { container } = render(withShell(<ForwardView cashTodayCents={123400} projection={null} moments={[]} />));
    expect(container.querySelector('h2')?.textContent).toMatch(/1,234/);
  });

  it('shows a dash, not $0, when there is no cash account (null)', () => {
    const { container } = render(withShell(<ForwardView cashTodayCents={null} projection={null} moments={[]} />));
    const headline = container.querySelector('h2')?.textContent ?? '';
    expect(headline).toMatch(/^— today → —/);
    expect(headline).not.toMatch(/\d/);
  });
});
