import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { StatusTimeline } from '../../components/StatusTimeline';

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const mockEntries = [
  {
    id: 'e1',
    fromStatus: 'PENDING',
    toStatus: 'DEPLOYING',
    reason: 'Deployment initiated',
    initiatedBy: 'user-abc',
    createdAt: '2025-06-01T10:00:00Z',
  },
  {
    id: 'e2',
    fromStatus: 'DEPLOYING',
    toStatus: 'ONLINE',
    createdAt: '2025-06-01T10:05:00Z',
  },
  {
    id: 'e3',
    toStatus: 'CREATED',
    reason: 'Initial creation',
    createdAt: '2025-06-01T09:55:00Z',
  },
];

describe('StatusTimeline', () => {
  it('shows "No status history" when fetch returns empty data', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: [] }),
    });

    render(<StatusTimeline deploymentId="dep-1" />);
    expect(screen.getByText('No status history')).toBeInTheDocument();
  });

  it('fetches and displays status entries', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockEntries }),
    });

    render(<StatusTimeline deploymentId="dep-1" />);

    await waitFor(() => {
      expect(screen.getByText('DEPLOYING')).toBeInTheDocument();
    });

    expect(screen.getByText('ONLINE')).toBeInTheDocument();
    expect(screen.getByText('CREATED')).toBeInTheDocument();
  });

  it('displays "from" status when present', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockEntries }),
    });

    render(<StatusTimeline deploymentId="dep-1" />);

    await waitFor(() => {
      expect(screen.getByText(/from PENDING/)).toBeInTheDocument();
    });
    expect(screen.getByText(/from DEPLOYING/)).toBeInTheDocument();
  });

  it('displays reason when present', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockEntries }),
    });

    render(<StatusTimeline deploymentId="dep-1" />);

    await waitFor(() => {
      expect(screen.getByText('Deployment initiated')).toBeInTheDocument();
    });
    expect(screen.getByText('Initial creation')).toBeInTheDocument();
  });

  it('displays initiatedBy when present', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockEntries }),
    });

    render(<StatusTimeline deploymentId="dep-1" />);

    await waitFor(() => {
      expect(screen.getByText(/by user-abc/)).toBeInTheDocument();
    });
  });

  it('calls fetch with the correct URL', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: [] }),
    });

    render(<StatusTimeline deploymentId="dep-42" />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/v1/deployment-manager/deployments/dep-42/history',
      );
    });
  });
});
