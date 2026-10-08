import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import * as kit from '@/app/app/_kit';
import { Sheet, focusableWithin } from '@/app/app/_kit/Sheet';
import { Banner, bannerStyle } from '@/app/app/_kit/Banner';
import { ToastHost, useToast, toastStyle, DEFAULT_TOAST_MS, CRITICAL_TOAST_MS } from '@/app/app/_kit/Toast';
import { tokens } from '@/app/app/_kit/tokens';
import { i18nT, renderWithI18n, expectTokenOnly, expectTouchTarget } from './test-utils';

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
  it('renders the title, body and action; a critical banner is an alert whose name includes the severity word', () => {
    renderWithI18n(<Banner severity="critical" title="Acme is overdue" body="12 days" action={<button type="button">Remind</button>} />);
    const alert = screen.getByRole('alert', { name: 'Critical: Acme is overdue' });
    expect(alert).toHaveAttribute('data-severity', 'critical');
    expect(alert).toHaveTextContent('Critical: Acme is overdue');
    expect(alert).toHaveTextContent('12 days');
    expect(screen.getByRole('button', { name: 'Remind' })).toBeInTheDocument();
  });

  it('warn and info banners stay a labelled group, each with its own severity prefix', () => {
    const { unmount } = renderWithI18n(<Banner severity="warn" title="Tax due soon" />);
    expect(screen.getByRole('group', { name: 'Warning: Tax due soon' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();
    renderWithI18n(<Banner severity="info" title="New feature" />);
    expect(screen.getByRole('group', { name: 'Notice: New feature' })).toBeInTheDocument();
  });

  it('the severity prefix is visually hidden but not display:none (screen readers still get it)', () => {
    renderWithI18n(<Banner severity="critical" title="X" />);
    const prefix = screen.getByText('Critical:');
    expect(prefix.style.position).toBe('absolute');
    expect(prefix.style.display).not.toBe('none');
    expect(prefix.style.visibility).not.toBe('hidden');
  });

  it.each(['fr-CA', 'zh-CN'])('severity prefixes exist in %s (not the English fallback)', (locale) => {
    const en = i18nT('en');
    const t = i18nT(locale);
    for (const k of ['mobile.kit.severity_critical', 'mobile.kit.severity_warn', 'mobile.kit.severity_info', 'mobile.kit.alerts']) {
      expect(t(k), k).not.toBe(en(k));
    }
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

describe('Toast severity routing', () => {
  function Say({ text, tone, durationMs }: { text: string; tone: 'neutral' | 'good' | 'critical'; durationMs?: number }) {
    const toast = useToast();
    return <button type="button" onClick={() => toast.show(text, { tone, durationMs })}>{text}-go</button>;
  }

  it('announces a critical toast in the assertive region and the others in the polite one', () => {
    renderWithI18n(
      <ToastHost>
        <Say text="bad" tone="critical" />
        <Say text="fine" tone="good" />
        <Say text="plain" tone="neutral" />
      </ToastHost>,
    );
    const polite = screen.getByRole('status', { name: 'Notifications' });
    const assertive = screen.getByRole('alert', { name: 'Alerts' });
    expect(assertive).toHaveAttribute('aria-live', 'assertive');
    // Both regions are mounted before any message exists.
    expect(polite).toBeEmptyDOMElement();
    expect(assertive).toBeEmptyDOMElement();
    fireEvent.click(screen.getByText('bad-go'));
    fireEvent.click(screen.getByText('fine-go'));
    fireEvent.click(screen.getByText('plain-go'));
    expect(assertive).toHaveTextContent('bad');
    expect(assertive).not.toHaveTextContent('fine');
    expect(polite).toHaveTextContent('fine');
    expect(polite).toHaveTextContent('plain');
    expect(polite).not.toHaveTextContent('bad');
  });

  it('critical toasts last longer by default than ordinary ones; an explicit duration still wins', () => {
    expect(CRITICAL_TOAST_MS).toBeGreaterThan(DEFAULT_TOAST_MS);
    vi.useFakeTimers();
    renderWithI18n(
      <ToastHost>
        <Say text="bad" tone="critical" />
        <Say text="fine" tone="good" />
        <Say text="quick" tone="critical" durationMs={500} />
      </ToastHost>,
    );
    fireEvent.click(screen.getByText('bad-go'));
    fireEvent.click(screen.getByText('fine-go'));
    fireEvent.click(screen.getByText('quick-go'));
    act(() => {
      vi.advanceTimersByTime(501);
    });
    expect(screen.queryByText('quick')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(DEFAULT_TOAST_MS);
    });
    expect(screen.queryByText('fine')).toBeNull();
    expect(screen.getByText('bad')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(CRITICAL_TOAST_MS);
    });
    expect(screen.queryByText('bad')).toBeNull();
  });

  it('clears pending timers on unmount and ignores show() afterwards', () => {
    vi.useFakeTimers();
    let api: ReturnType<typeof useToast> | undefined;
    function Grab() {
      api = useToast();
      return null;
    }
    const { unmount } = renderWithI18n(
      <ToastHost>
        <Grab />
        <Say text="bad" tone="critical" />
      </ToastHost>,
    );
    fireEvent.click(screen.getByText('bad-go'));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => api!.show('late', { tone: 'good' }));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Sheet stacking, portal and focus order', () => {
  function Two({ outer, inner, onOuter, onInner }: { outer: boolean; inner: boolean; onOuter: () => void; onInner: () => void }) {
    return (
      <>
        <Sheet open={outer} onClose={onOuter} title="Outer">o</Sheet>
        <Sheet open={inner} onClose={onInner} title="Inner">i</Sheet>
      </>
    );
  }

  it('Escape closes only the topmost sheet', () => {
    const onOuter = vi.fn();
    const onInner = vi.fn();
    renderWithI18n(<Two outer inner onOuter={onOuter} onInner={onInner} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onInner).toHaveBeenCalledTimes(1);
    expect(onOuter).not.toHaveBeenCalled();
  });

  it('keeps the page locked until the last sheet closes, in any order, restoring overflow once', () => {
    document.body.style.overflow = 'scroll';
    const noop = () => {};
    const { rerender } = renderWithI18n(<Two outer inner onOuter={noop} onInner={noop} />);
    expect(document.body.style.overflow).toBe('hidden');
    rerender(<Two outer={false} inner onOuter={noop} onInner={noop} />);
    expect(document.body.style.overflow).toBe('hidden');
    rerender(<Two outer={false} inner={false} onOuter={noop} onInner={noop} />);
    expect(document.body.style.overflow).toBe('scroll');
    document.body.style.overflow = '';
  });

  it('after the inner sheet closes the outer one handles Escape again', () => {
    const onOuter = vi.fn();
    const { rerender } = renderWithI18n(<Two outer inner onOuter={onOuter} onInner={() => {}} />);
    rerender(<Two outer inner={false} onOuter={onOuter} onInner={() => {}} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOuter).toHaveBeenCalledTimes(1);
  });

  it('renders through a portal on document.body, outside the React container', () => {
    const { container } = renderWithI18n(<Sheet open onClose={() => {}} title="P">x</Sheet>);
    const dialog = screen.getByRole('dialog');
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });

  it('Tab skips disabled, hidden and aria-hidden controls', () => {
    renderWithI18n(
      <Sheet open onClose={() => {}} title="T">
        <button type="button" disabled>disabled</button>
        <button type="button" hidden>hidden</button>
        <button type="button" style={{ display: 'none' }}>none</button>
        <div aria-hidden="true"><button type="button">aria</button></div>
        <div style={{ visibility: 'hidden' }}><button type="button">invisible</button></div>
        <input type="hidden" />
        <button type="button">real</button>
      </Sheet>,
    );
    const names = focusableWithin(screen.getByRole('dialog')).map((el) => el.textContent || el.getAttribute('aria-label'));
    expect(names).toEqual(['Close', 'real']);
    screen.getByRole('button', { name: 'real' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });
});

describe('kit barrel', () => {
  it('exports everything C4 promises', () => {
    for (const name of ['Card', 'Sheet', 'Chip', 'Banner', 'Skeleton', 'Pill', 'Thumb', 'Toast', 'useToast', 'ToastHost', 'EmptyState', 'Money', 'tokens']) {
      expect((kit as Record<string, unknown>)[name], name).toBeDefined();
    }
  });
});
