import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import * as kit from '@/app/app/_kit';
import { Sheet } from '@/app/app/_kit/Sheet';
import { Banner, bannerStyle } from '@/app/app/_kit/Banner';
import { ToastHost, useToast, toastStyle } from '@/app/app/_kit/Toast';
import { tokens } from '@/app/app/_kit/tokens';
import { renderWithI18n, expectTokenOnly, expectTouchTarget } from './test-utils';

afterEach(() => {
  vi.useRealTimers();
});

describe('Sheet', () => {
  it('renders nothing while closed', () => {
    renderWithI18n(<Sheet open={false} onClose={() => {}} title="Details">x</Sheet>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a labelled modal dialog that takes focus', () => {
    renderWithI18n(<Sheet open onClose={() => {}} title="Outstanding">content</Sheet>);
    const dialog = screen.getByRole('dialog', { name: 'Outstanding' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent('content');
    expect(document.activeElement).toBe(dialog);
  });

  it('closes on Escape, on the backdrop, and on the 44px close button', () => {
    const onClose = vi.fn();
    renderWithI18n(<Sheet open onClose={onClose} title="T">x</Sheet>);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('sheet-backdrop'));
    const close = screen.getByRole('button', { name: 'Close' });
    expectTouchTarget(close);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('locks page scroll while open and restores it on close', () => {
    document.body.style.overflow = 'auto';
    const { rerender } = renderWithI18n(<Sheet open onClose={() => {}} title="T">x</Sheet>);
    expect(document.body.style.overflow).toBe('hidden');
    rerender(<Sheet open={false} onClose={() => {}} title="T">x</Sheet>);
    expect(document.body.style.overflow).toBe('auto');
    document.body.style.overflow = '';
  });

  it('puts focus back on the trigger when it closes', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { rerender } = renderWithI18n(<Sheet open onClose={() => {}} title="T">x</Sheet>);
    expect(document.activeElement).not.toBe(trigger);
    rerender(<Sheet open={false} onClose={() => {}} title="T">x</Sheet>);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('keeps Tab inside the dialog', () => {
    renderWithI18n(
      <Sheet open onClose={() => {}} title="T">
        <button type="button">inner</button>
      </Sheet>,
    );
    const inner = screen.getByRole('button', { name: 'inner' });
    inner.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('pads the bottom for the home-indicator safe area', () => {
    renderWithI18n(<Sheet open onClose={() => {}} title="T">x</Sheet>);
    expect(screen.getByRole('dialog').style.padding).toContain('env(safe-area-inset-bottom)');
  });
});

describe('Banner', () => {
  it('renders the title, body and action, and exposes its severity', () => {
    renderWithI18n(<Banner severity="critical" title="Acme is overdue" body="12 days" action={<button type="button">Remind</button>} />);
    const group = screen.getByRole('group', { name: 'Acme is overdue' });
    expect(group).toHaveAttribute('data-severity', 'critical');
    expect(group).toHaveTextContent('12 days');
    expect(screen.getByRole('button', { name: 'Remind' })).toBeInTheDocument();
  });

  it.each(['critical', 'warn', 'info'] as const)('%s banner is token-only', (severity) => {
    expectTokenOnly(bannerStyle(severity));
  });

  it('critical uses the critical accent; info uses the brand accent', () => {
    expect(String(bannerStyle('critical').borderLeft)).toContain(tokens.color.critical);
    expect(String(bannerStyle('info').borderLeft)).toContain(tokens.color.primary);
  });
});

function Shout({ text }: { text: string }) {
  const toast = useToast();
  return <button type="button" onClick={() => toast.show(text, { tone: 'good', durationMs: 1000 })}>shout</button>;
}

describe('Toast', () => {
  it('shows a message in a polite live region and removes it after its duration', () => {
    vi.useFakeTimers();
    renderWithI18n(<ToastHost><Shout text="Reminder sent" /></ToastHost>);
    fireEvent.click(screen.getByRole('button', { name: 'shout' }));
    const region = screen.getByRole('status', { name: 'Notifications' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Reminder sent');
    act(() => {
      vi.advanceTimersByTime(1001);
    });
    expect(region).not.toHaveTextContent('Reminder sent');
  });

  it('keeps at most three toasts on screen', () => {
    renderWithI18n(<ToastHost><Shout text="m" /></ToastHost>);
    const btn = screen.getByRole('button', { name: 'shout' });
    for (let i = 0; i < 5; i++) fireEvent.click(btn);
    expect(screen.getAllByText('m')).toHaveLength(3);
  });

  it('useToast outside a host is a harmless no-op, not a crash', () => {
    renderWithI18n(<Shout text="x" />);
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'shout' }))).not.toThrow();
  });

  it.each(['neutral', 'good', 'critical'] as const)('%s toast is token-only', (tone) => {
    expectTokenOnly(toastStyle(tone));
  });
});

describe('kit barrel', () => {
  it('exports everything C4 promises', () => {
    for (const name of ['Card', 'Sheet', 'Chip', 'Banner', 'Skeleton', 'Pill', 'Thumb', 'Toast', 'useToast', 'ToastHost', 'EmptyState', 'Money', 'tokens']) {
      expect((kit as Record<string, unknown>)[name], name).toBeDefined();
    }
  });
});
