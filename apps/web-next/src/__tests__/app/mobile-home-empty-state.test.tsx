/**
 * Mobile/PWA Home — first-run, populated, and failed-load states.
 *
 * Kept from the original file's intent: a brand-new account must not land on
 * zero tiles (reads as broken) and must always get real, tappable next steps;
 * a failed load must never be mistaken for an empty account. The page now
 * reads /mobile/home through the typed client, so fetch is mocked at the
 * network boundary, not the module.
 */
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import MobileHomePage from '@/app/app/page';
import { ToastHost } from '@/app/app/_kit/Toast';
import { renderWithI18n, routeFetch, jsonResponse } from './mobile/test-utils';
import { homeFixture } from './mobile/fixtures';

const HOME_URL = '/api/v1/agentbook-core/mobile/home';

function renderHome() {
  return renderWithI18n(<ToastHost><MobileHomePage /></ToastHost>);
}

/**
 * The error card (role="alert"). Found by test id: the ToastHost keeps its own
 * empty role="alert" live region mounted, and a critical banner is an alert too.
 */
function errorCard() {
  const el = screen.getByTestId('home-error');
  expect(el).toHaveAttribute('role', 'alert');
  return el;
}

beforeEach(() => {
  window.localStorage.clear();
});

const BRAND_NEW = homeFixture({
  isBrandNew: true,
  alerts: [],
  nextUp: [],
  recent: [],
  kpis: { monthNetCents: 0, cashTodayCents: null, outstandingCents: 0, overdueCount: 0, overdueCents: 0, estTaxOwedCents: 0 },
});

describe('MobileHome — empty state (new account)', () => {
  it('welcomes the user and explains what to do instead of showing zero tiles', async () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: BRAND_NEW }) });
    renderHome();
    await waitFor(() => expect(screen.getByText(/let’s get your books started/i)).toBeInTheDocument());
    expect(screen.getByText(/start filling in/i)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Key numbers' })).toBeNull();
    expect(screen.queryByTestId('alert-carousel')).toBeNull();
  });

  it('offers tappable next steps that link to real destinations', async () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: BRAND_NEW }) });
    renderHome();
    await waitFor(() => expect(screen.getByText(/Snap a receipt/i)).toBeInTheDocument());
    const hrefs = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining(['/app/capture', '/app/chat', '/app/docs']));
  });
});

describe('MobileHome — with data', () => {
  it('shows the banner, the four KPIs, next up, recent activity and quick actions', async () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: true, data: homeFixture() }) });
    renderHome();
    const region = await screen.findByRole('region', { name: 'Key numbers' });
    expect(region.querySelectorAll('[data-kpi]')).toHaveLength(4);
    expect(screen.getByTestId('alert-carousel')).toHaveTextContent('Acme · CA$1,800 is 12 days overdue');
    expect(screen.getByRole('heading', { name: 'Next up' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent activity' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Snap receipt' })).toHaveAttribute('href', '/app/capture');
    expect(screen.queryByText(/let’s get your books started/i)).toBeNull();
  });
});

describe('MobileHome — failed load', () => {
  it('says it could not load rather than implying the books are empty, and Retry recovers', async () => {
    let calls = 0;
    routeFetch({
      [HOME_URL]: () => {
        calls += 1;
        return calls === 1 ? jsonResponse(500, { success: false, error: 'Internal error' }) : jsonResponse(200, { success: true, data: homeFixture() });
      },
    });
    renderHome();
    await waitFor(() => expect(errorCard()).toHaveTextContent('Couldn’t load this'));
    expect(screen.queryByText(/let’s get your books started/i)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Key numbers' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Key numbers' })).toBeInTheDocument();
  });

  it('treats an unsuccessful payload as a failure too', async () => {
    routeFetch({ [HOME_URL]: () => jsonResponse(200, { success: false, error: 'boom' }) });
    renderHome();
    await waitFor(() => expect(errorCard()).toHaveTextContent('Couldn’t load this'));
  });

  it('a dropped connection with nothing cached says offline, not "failed"', async () => {
    routeFetch({ [HOME_URL]: () => new TypeError('Failed to fetch') });
    renderHome();
    await waitFor(() => expect(errorCard()).toHaveTextContent('You’re offline'));
  });
});
