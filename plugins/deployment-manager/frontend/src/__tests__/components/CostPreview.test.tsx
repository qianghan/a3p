import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { CostPreview } from '../../components/CostPreview';

describe('CostPreview', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false }),
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('renders nothing when providerSlug is null', () => {
    const { container } = render(<CostPreview providerSlug={null} gpuModel="A100" gpuCount={1} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when gpuModel is null', () => {
    const { container } = render(<CostPreview providerSlug="fal-ai" gpuModel={null} gpuCount={1} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders self-hosted message for ssh-bridge', async () => {
    await act(async () => {
      render(<CostPreview providerSlug="ssh-bridge" gpuModel="A100" gpuCount={1} />);
    });
    expect(screen.getByText('Self-hosted')).toBeInTheDocument();
    expect(screen.getByText(/No GPU rental charges/)).toBeInTheDocument();
  });

  it('shows loading state while fetching', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    await act(async () => {
      render(<CostPreview providerSlug="fal-ai" gpuModel="A100" gpuCount={1} />);
    });

    expect(screen.getByText('Estimating cost...')).toBeInTheDocument();
  });

  it('renders cost estimate after successful fetch', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          gpuCostPerHour: 0.50,
          totalCostPerHour: 0.60,
          totalCostPerDay: 14.40,
          totalCostPerMonth: 432,
          currency: 'USD',
          breakdown: { gpu: 0.50, storage: 0.10, network: 0 },
          providerSlug: 'fal-ai',
          gpuModel: 'A100',
          gpuCount: 1,
        },
      }),
    });

    await act(async () => {
      render(<CostPreview providerSlug="fal-ai" gpuModel="A100" gpuCount={1} />);
    });

    await waitFor(() => {
      expect(screen.getByText('$0.60')).toBeInTheDocument();
      expect(screen.getByText('/hour')).toBeInTheDocument();
      expect(screen.getByText('$14.40/day')).toBeInTheDocument();
      expect(screen.getByText('$432/month')).toBeInTheDocument();
    });
  });

  it('renders green cost colors for low hourly cost', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          gpuCostPerHour: 0.30,
          totalCostPerHour: 0.40,
          totalCostPerDay: 9.60,
          totalCostPerMonth: 288,
          currency: 'USD',
          breakdown: { gpu: 0.30, storage: 0.10, network: 0 },
          providerSlug: 'fal-ai',
          gpuModel: 'T4',
          gpuCount: 1,
        },
      }),
    });

    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<CostPreview providerSlug="fal-ai" gpuModel="T4" gpuCount={1} />));
    });

    await waitFor(() => {
      const costEl = screen.getByText('$0.40');
      expect(costEl.style.color).toBe('rgb(22, 101, 52)');
      expect(container!.firstElementChild!.getAttribute('style')).toContain('rgb(240, 253, 244)');
    });
  });

  it('renders GPU breakdown', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          gpuCostPerHour: 2.00,
          totalCostPerHour: 2.50,
          totalCostPerDay: 60,
          totalCostPerMonth: 1800,
          currency: 'USD',
          breakdown: { gpu: 2.00, storage: 0.50, network: 0 },
          providerSlug: 'fal-ai',
          gpuModel: 'A100',
          gpuCount: 2,
        },
      }),
    });

    await act(async () => {
      render(<CostPreview providerSlug="fal-ai" gpuModel="A100" gpuCount={2} />);
    });

    await waitFor(() => {
      expect(screen.getByText('GPU: $2.00')).toBeInTheDocument();
      expect(screen.getByText('Storage: $0.50')).toBeInTheDocument();
    });
  });

  it('renders nothing when fetch returns unsuccessful response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: false }),
    });

    let container: HTMLElement;
    await act(async () => {
      ({ container } = render(<CostPreview providerSlug="fal-ai" gpuModel="A100" gpuCount={1} />));
    });

    await waitFor(() => {
      expect(container!.firstChild).toBeNull();
    });
  });
});
