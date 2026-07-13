import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StartupDiscoveryPage } from '../pages/StartupDiscoveryPage';

const getProfile = vi.fn();
const saveProfile = vi.fn();
const getRecommendations = vi.fn();
const getAddOnTeaser = vi.fn();
const createApplication = vi.fn();
const listApplications = vi.fn();

vi.mock('../lib/api', () => ({
  startupApi: {
    getProfile: () => getProfile(),
    saveProfile: (input: unknown) => saveProfile(input),
    getRecommendations: () => getRecommendations(),
    getAddOnTeaser: () => getAddOnTeaser(),
    createApplication: (programCode: string) => createApplication(programCode),
    listApplications: () => listApplications(),
  },
  formatCents: (cents: number) => `$${(cents / 100).toLocaleString()}`,
}));

vi.mock('@naap/ui', () => ({
  AddOnCheckoutModal: ({
    onDone, onClose, title,
  }: { onDone: () => void; onClose: () => void; title: string }) => (
    <div data-testid="addon-checkout-modal">
      <span>{title}</span>
      <button onClick={onDone}>mock-confirm</button>
      <button onClick={onClose}>mock-close</button>
    </div>
  ),
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <StartupDiscoveryPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getProfile.mockReset(); saveProfile.mockReset(); getRecommendations.mockReset(); getAddOnTeaser.mockReset();
  createApplication.mockReset(); listApplications.mockReset();
  getProfile.mockResolvedValue(null);
  getAddOnTeaser.mockResolvedValue({ active: false, price: { tier: 'founding_member', priceCents: 9900, currency: 'usd' } });
  listApplications.mockResolvedValue({ applications: [] });
});

describe('StartupDiscoveryPage', () => {
  it('renders the intake form when no profile is saved yet', async () => {
    renderPage();
    await waitFor(() => expect(getProfile).toHaveBeenCalled());
    expect(screen.getByLabelText(/company type/i)).toBeTruthy();
    expect(screen.getByLabelText(/annual r&d spend/i)).toBeTruthy();
  });

  it('saves the profile and shows recommendations on submit', async () => {
    saveProfile.mockResolvedValue({ tenantId: 't1', companyType: 'c_corp', incorporatedAt: null, headcount: 4, annualRdSpendCents: 40_000_000, equityRaisedCents: null });
    getRecommendations.mockResolvedValue({
      jurisdiction: 'us',
      programs: [{
        programCode: 'us_rd_credit_41', name: 'Federal R&D Tax Credit (IRC §41)', authority: 'IRS',
        sourceUrl: 'https://www.irs.gov/forms-pubs/about-form-6765', status: 'qualified', confidence: 0.75,
        reasoning: 'Likely qualifies under the four-part test.', estValueLowCents: 4_000_000, estValueHighCents: 8_000_000,
      }],
    });
    renderPage();
    await waitFor(() => expect(getProfile).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/company type/i), { target: { value: 'c_corp' } });
    fireEvent.change(screen.getByLabelText(/headcount/i), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText(/annual r&d spend/i), { target: { value: '400000' } });
    fireEvent.click(screen.getByRole('button', { name: /see what i qualify for/i }));

    await waitFor(() => expect(saveProfile).toHaveBeenCalledWith(expect.objectContaining({ companyType: 'c_corp', headcount: 4, annualRdSpendCents: 40_000_000 })));
    await waitFor(() => expect(screen.getByText('Federal R&D Tax Credit (IRC §41)')).toBeTruthy());
    expect(screen.getByText(/\$40,000 – \$80,000/)).toBeTruthy();
    expect(screen.getByText(/qualified/i)).toBeTruthy();
  });

  it('shows the jurisdiction-unsupported message when the backend returns one', async () => {
    saveProfile.mockResolvedValue({ tenantId: 't1', companyType: null, incorporatedAt: null, headcount: null, annualRdSpendCents: null, equityRaisedCents: null });
    getRecommendations.mockResolvedValue({ jurisdiction: 'ca', programs: [], message: 'Startup tax benefits are not yet available for your jurisdiction.' });
    renderPage();
    await waitFor(() => expect(getProfile).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /see what i qualify for/i }));
    await waitFor(() => expect(screen.getByText(/not yet available for your jurisdiction/i)).toBeTruthy());
  });

  it('shows the founding-member price teaser without a purchase button', async () => {
    renderPage();
    await waitFor(() => expect(getAddOnTeaser).toHaveBeenCalled());
    expect(screen.getByText(/\$99/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /subscribe|buy|purchase/i })).toBeNull();
  });

  it('lists in-progress applications so a founder can resume one later (story C5)', async () => {
    listApplications.mockResolvedValue({
      applications: [{ id: 'app-1', status: 'decision_pending', draft: { programCode: 'us_rd_credit_41' } }],
    });
    renderPage();
    await waitFor(() => expect(listApplications).toHaveBeenCalled());
    expect(await screen.findByText(/your applications/i)).toBeTruthy();
    expect(screen.getByText(/your input needed/i)).toBeTruthy();
  });

  it('shows an Upgrade button when the add-on is not active, and opens the checkout modal', async () => {
    renderPage();
    await waitFor(() => expect(getAddOnTeaser).toHaveBeenCalled());
    const upgradeButton = await screen.findByRole('button', { name: /upgrade/i });
    fireEvent.click(upgradeButton);
    expect(screen.getByTestId('addon-checkout-modal')).toBeTruthy();
  });

  it('re-fetches the teaser and closes the modal once checkout completes', async () => {
    renderPage();
    await waitFor(() => expect(getAddOnTeaser).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: /upgrade/i }));
    getAddOnTeaser.mockResolvedValue({ active: true, price: { tier: 'founding_member', priceCents: 9900, currency: 'usd' } });
    fireEvent.click(screen.getByText('mock-confirm'));
    await waitFor(() => expect(getAddOnTeaser).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('addon-checkout-modal')).toBeNull());
    await waitFor(() => expect(screen.queryByRole('button', { name: /upgrade/i })).toBeNull());
  });

  it('does not show the Upgrade button once the add-on is already active', async () => {
    getAddOnTeaser.mockResolvedValue({ active: true, price: { tier: 'founding_member', priceCents: 9900, currency: 'usd' } });
    renderPage();
    await waitFor(() => expect(getAddOnTeaser).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /upgrade/i })).toBeNull();
  });
});
