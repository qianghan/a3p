import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AddOnCheckoutModal } from '@naap/ui';

const mockConfirmSetup = vi.fn();

vi.mock('@stripe/stripe-js', () => ({
  loadStripe: vi.fn(() => Promise.resolve({})),
}));

vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div data-testid="elements">{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmSetup: mockConfirmSetup }),
  useElements: () => ({}),
}));

beforeEach(() => {
  mockConfirmSetup.mockReset();
});

describe('AddOnCheckoutModal', () => {
  it('shows a loading state, then the PaymentElement once the client secret resolves', async () => {
    const fetchClientSecret = vi.fn().mockResolvedValue({ clientSecret: 'seti_123_secret_abc' });
    render(
      <AddOnCheckoutModal
        title="Startup Tax Benefits"
        priceLabel="$99/year"
        onClose={() => {}}
        fetchClientSecret={fetchClientSecret}
        onConfirmed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByText(/preparing checkout/i)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('payment-element')).toBeTruthy());
  });

  it('shows an error if fetching the client secret fails', async () => {
    const fetchClientSecret = vi.fn().mockRejectedValue(new Error('no customer'));
    render(
      <AddOnCheckoutModal
        title="Startup Tax Benefits"
        onClose={() => {}}
        fetchClientSecret={fetchClientSecret}
        onConfirmed={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText('no customer')).toBeTruthy());
  });

  it('confirms setup, calls onConfirmed with the payment method id, then onDone', async () => {
    const fetchClientSecret = vi.fn().mockResolvedValue({ clientSecret: 'seti_123_secret_abc' });
    const onConfirmed = vi.fn().mockResolvedValue(undefined);
    const onDone = vi.fn();
    mockConfirmSetup.mockResolvedValue({ setupIntent: { payment_method: 'pm_test_123' } });

    render(
      <AddOnCheckoutModal
        title="Startup Tax Benefits"
        onClose={() => {}}
        fetchClientSecret={fetchClientSecret}
        onConfirmed={onConfirmed}
        onDone={onDone}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('payment-element')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /subscribe/i }));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith('pm_test_123'));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('shows an inline error when confirmSetup fails and does not call onConfirmed', async () => {
    const fetchClientSecret = vi.fn().mockResolvedValue({ clientSecret: 'seti_123_secret_abc' });
    const onConfirmed = vi.fn();
    mockConfirmSetup.mockResolvedValue({ error: { message: 'Your card was declined.' } });

    render(
      <AddOnCheckoutModal
        title="Startup Tax Benefits"
        onClose={() => {}}
        fetchClientSecret={fetchClientSecret}
        onConfirmed={onConfirmed}
        onDone={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('payment-element')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /subscribe/i }));
    await waitFor(() => expect(screen.getByText('Your card was declined.')).toBeTruthy());
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});
