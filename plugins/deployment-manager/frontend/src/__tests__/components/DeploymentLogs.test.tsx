import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { DeploymentLogs } from '../../components/DeploymentLogs';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DeploymentLogs', () => {
  it('should show waiting message when no logs', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: [] }),
    });
    await act(async () => {
      render(<DeploymentLogs deploymentId="test-1" />);
    });
    await waitFor(() => {
      expect(screen.getByText('Waiting for logs...')).toBeInTheDocument();
    });
  });

  it('should render log entries', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({
        success: true,
        data: [
          { createdAt: '2026-01-01T00:00:00Z', toStatus: 'DEPLOYING', reason: 'Deploy started' },
          { createdAt: '2026-01-01T00:01:00Z', toStatus: 'ONLINE', reason: 'Healthy' },
        ],
      }),
    });
    await act(async () => {
      render(<DeploymentLogs deploymentId="test-1" />);
    });
    await waitFor(() => {
      expect(screen.getByText(/DEPLOYING: Deploy started/)).toBeInTheDocument();
      expect(screen.getByText(/ONLINE: Healthy/)).toBeInTheDocument();
    });
  });

  it('should display header with title', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: [] }),
    });
    await act(async () => {
      render(<DeploymentLogs deploymentId="test-1" />);
    });
    expect(screen.getByText('Deployment Logs')).toBeInTheDocument();
  });

  it('should handle fetch error gracefully', async () => {
    (global.fetch as any).mockRejectedValue(new Error('fail'));
    await act(async () => {
      render(<DeploymentLogs deploymentId="test-1" />);
    });
    await waitFor(() => {
      expect(screen.getByText('Waiting for logs...')).toBeInTheDocument();
    });
  });
});
