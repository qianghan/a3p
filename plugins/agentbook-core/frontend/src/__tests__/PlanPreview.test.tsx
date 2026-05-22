import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanPreview } from '../components/PlanPreview';

describe('PlanPreview', () => {
  it('renders all steps', () => {
    render(
      <PlanPreview
        steps={[
          { description: 'Send invoice INV-2026-0042 to acme@example.com' },
          { description: 'Mark as sent' },
        ]}
        onProceed={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/Send invoice INV-2026-0042/)).toBeDefined();
    expect(screen.getByText(/Mark as sent/)).toBeDefined();
  });

  it('shows the "I\'d like to do this" header', () => {
    render(
      <PlanPreview
        steps={[{ description: 'X' }]}
        onProceed={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/I.d like to do this/i)).toBeDefined();
  });

  it('calls onProceed when Proceed clicked', async () => {
    const user = userEvent.setup();
    const onProceed = vi.fn();
    render(
      <PlanPreview
        steps={[{ description: 'X' }]}
        onProceed={onProceed}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /proceed/i }));
    expect(onProceed).toHaveBeenCalledOnce();
  });

  it('calls onCancel when Cancel clicked', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <PlanPreview
        steps={[{ description: 'X' }]}
        onProceed={() => {}}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('disables buttons when disabled prop is true', () => {
    render(
      <PlanPreview
        steps={[{ description: 'X' }]}
        onProceed={() => {}}
        onCancel={() => {}}
        disabled
      />,
    );
    const proceed = screen.getByRole('button', { name: /proceed/i }) as HTMLButtonElement;
    const cancel = screen.getByRole('button', { name: /cancel/i }) as HTMLButtonElement;
    expect(proceed.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
  });
});
