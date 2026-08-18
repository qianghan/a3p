/**
 * The shell language switcher.
 *
 * A picker already existed in Business Profile settings; this is the one a
 * user actually finds. Both write the same AbTenantConfig.locale field, so
 * there is no second source of truth to drift.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

import { LanguageSwitcher } from '../language-switcher';

const originalFetch = global.fetch;

function mockConfig(locale: string) {
  global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      return { ok: true, json: async () => ({ success: true }) } as Response;
    }
    return { ok: true, json: async () => ({ success: true, data: { locale } }) } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  // jsdom has no navigation; the component reloads after a successful save.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload: vi.fn() },
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('LanguageSwitcher', () => {
  it('lists every offerable language, each named in its OWN language', async () => {
    // The point of native labels: someone who cannot read the current UI
    // language still recognises their own in the list.
    mockConfig('en-US');
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /change language/i }));

    // Scope to the menu: the TRIGGER also shows the current language, so a
    // bare getByText('English (US)') matches two nodes.
    const menu = within(screen.getByRole('menu'));
    expect(menu.getByText('English (US)')).toBeTruthy();
    expect(menu.getByText('Français (Canada)')).toBeTruthy();
    expect(menu.getByText('简体中文')).toBeTruthy();
  });

  it('ticks the tenant’s current language', async () => {
    mockConfig('fr-CA');
    render(<LanguageSwitcher />);
    await waitFor(() => {
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByRole('button', { name: /change language/i }));
    await waitFor(() => {
      const fr = screen.getByRole('menuitemradio', { name: /Français/ });
      expect(fr.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('maps a LEGACY stored value onto the right option', async () => {
    // CA tenants may hold 'en-CA' from the old Canada-only selector. Without
    // this mapping the menu would tick nothing, and picking a language would
    // look like a no-op.
    mockConfig('en-CA');
    render(<LanguageSwitcher />);
    await waitFor(() => {
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByRole('button', { name: /change language/i }));
    await waitFor(() => {
      const en = screen.getByRole('menuitemradio', { name: /English/ });
      expect(en.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('PUTs the chosen locale to tenant-config', async () => {
    mockConfig('en-US');
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /change language/i }));
    fireEvent.click(within(screen.getByRole('menu')).getByText('简体中文'));

    await waitFor(() => {
      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const put = calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
      expect(put, 'expected a PUT to tenant-config').toBeTruthy();
      expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({ locale: 'zh-CN' });
    });
  });

  it('does not PUT when the user re-picks the language they already have', async () => {
    mockConfig('en-US');
    render(<LanguageSwitcher />);
    await waitFor(() => {
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByRole('button', { name: /change language/i }));
    fireEvent.click(within(screen.getByRole('menu')).getByText('English (US)'));

    const puts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
    expect(puts.length).toBe(0);
  });

  it('closes on Escape', async () => {
    mockConfig('en-US');
    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /change language/i }));
    expect(screen.queryByRole('menu')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('mounts with NO ShellProvider — the PWA shell has none', async () => {
    // This is the crash that was one commit away from shipping. The mobile PWA
    // shell (app/app/layout.tsx) has no ShellProvider, and web-next's
    // useShell() THROWS without one, so a switcher that called it would have
    // taken the entire PWA down.
    //
    // Note there is deliberately no vi.mock of shell-context in this file:
    // mocking it would make this test pass even if the component started
    // calling useShell again.
    mockConfig('en-US');
    expect(() => render(<LanguageSwitcher />)).not.toThrow();
    fireEvent.click(screen.getByRole('button', { name: /change language/i }));
    expect(within(screen.getByRole('menu')).getByText('简体中文')).toBeTruthy();
  });

  it('reports a failed save inline rather than through shell notifications', async () => {
    // Same reason: shell.notifications is unreachable without a provider.
    global.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') return { ok: false, status: 500 } as Response;
      return { ok: true, json: async () => ({ success: true, data: { locale: 'en-US' } }) } as Response;
    }) as unknown as typeof fetch;

    render(<LanguageSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /change language/i }));
    fireEvent.click(within(screen.getByRole('menu')).getByText('简体中文'));
    await waitFor(() => {
      expect(screen.getByText(/could not change language/i)).toBeTruthy();
    });
  });

  it('survives a failed config fetch instead of blanking the header', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(() => render(<LanguageSwitcher />)).not.toThrow();
    expect(screen.getByRole('button', { name: /change language/i })).toBeTruthy();
  });
});
