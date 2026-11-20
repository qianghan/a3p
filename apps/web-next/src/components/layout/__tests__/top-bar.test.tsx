/**
 * The top bar's view title.
 *
 * This string sits at the top of EVERY page, and it was English on every one
 * of them — a French reader who had switched the whole shell still read
 * "Dashboard". That reads as a broken language switcher rather than as one
 * missing string, which is why it is worth a test of its own.
 *
 * The assertions are on RENDERED TEXT, and each names the English the old code
 * produced, so a regression fails for the right reason rather than on
 * incidental drift.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const pathname = { current: '/agentbook' };
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));

// The bar's other children fetch and hold state of their own; none of them is
// under test here.
vi.mock('../notification-bell', () => ({ NotificationBell: () => null }));
vi.mock('../language-switcher', () => ({ LanguageSwitcher: () => null }));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/contexts/shell-context', async () => {
  const react = await import('react');
  return {
    useShell: () => ({ toggleMobileMenu: vi.fn() }),
    ShellContextReact: react.createContext(null),
  };
});

/** Stands in for the catalog: French for the keys this bar can ask for. */
const FR: Record<string, string> = {
  'nav.dashboard': 'Tableau de bord',
  'nav.admin': 'Administration',
  'nav.teams': 'Équipes',
  'nav.documentation': 'Documentation',
  'nav.personal_finance': 'Finances personnelles',
  'common.settings': 'Paramètres',
  'dash.overview': "Vue d'ensemble",
  'nav.marketplace': 'Place de marché',
  'nav.feedback': 'Commentaires',
  'nav.account_access': 'Accès au compte',
  'core_ui.employee_profile': 'Profil de l\'employé',
};

let translate: (key: string) => string;
vi.mock('@/hooks/use-t', () => ({ useT: () => (key: string) => translate(key) }));

import { TopBar } from '../top-bar';

beforeEach(() => {
  translate = (key) => FR[key] ?? `MISSING:${key}`;
  pathname.current = '/agentbook';
});

describe('TopBar view title', () => {
  it('renders the dashboard title in the active locale, not English', () => {
    render(<TopBar />);
    expect(screen.getByText('Tableau de bord')).toBeTruthy();
    // Exactly what every page showed before, in every locale.
    expect(screen.queryByText('Dashboard')).toBeNull();
  });

  it.each([
    ['/settings', 'Paramètres'],
    ['/teams', 'Équipes'],
    ['/docs', 'Documentation'],
    ['/admin/users', 'Administration'],
    ['/personal', 'Finances personnelles'],
    ['/', 'Tableau de bord'],
  ])('translates %s', (path, expected) => {
    pathname.current = path;
    render(<TopBar />);
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it('asks the catalog for every path in its map — no key is missing', () => {
    // A typo in a key would otherwise show up only as a humanised fallback in
    // production, which reads close enough to English to go unnoticed.
    const asked: string[] = [];
    translate = (key) => {
      asked.push(key);
      return FR[key] ?? `MISSING:${key}`;
    };
    for (const path of ['/', '/agentbook', '/settings', '/teams', '/marketplace',
      '/feedback', '/docs', '/admin/users', '/accountant', '/personal']) {
      pathname.current = path;
      render(<TopBar />);
    }
    expect(asked.length).toBeGreaterThanOrEqual(10);
    expect(screen.queryAllByText(/^MISSING:/)).toHaveLength(0);
  });

  it('falls back to the route slug for a plugin route, and does not crash', () => {
    // Plugin routes have no key to look up. A recognisable English name beats
    // a raw dotted key or a blank bar.
    pathname.current = '/agentbook/expenses/review-queue';
    render(<TopBar />);
    expect(screen.getByText('Review Queue')).toBeTruthy();
  });

  it('uses the overview key when the path has no segments at all', () => {
    pathname.current = '';
    render(<TopBar />);
    expect(screen.getByText("Vue d'ensemble")).toBeTruthy();
  });
});

describe('TopBar never renders a record id as the title', () => {
  const UUID = 'b5ce8add-3541-42a8-9f0c-1a2b3c4d5e6f';
  it('payroll employee detail shows the catalog title', () => {
    pathname.current = `/payroll/employees/${UUID}`;
    render(<TopBar />);
    expect(screen.getByText("Profil de l'employé")).toBeTruthy();
    expect(screen.queryByText(/B5ce8add/i)).toBeNull();
  });
  it.each([
    `/anything/else/${UUID}`,
    `/invoices/${UUID}`,
    '/foo/ckx9z8y7w6v5u4t3s2r1q0p9o',
    '/foo/0123456789abcdef01234567',
  ])('%s falls back to the parent segment, never the id', (path) => {
    pathname.current = path;
    const { container } = render(<TopBar />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/b5ce8add|ckx9z8y7|0123456789abcdef/i);
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
