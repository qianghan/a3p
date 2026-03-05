import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DeploymentList } from '../../pages/DeploymentList';

const mockDeployments = [
  {
    id: '1', name: 'deploy-alpha', providerSlug: 'fal-ai', providerMode: 'serverless',
    gpuModel: 'A100', gpuVramGb: 80, gpuCount: 1, artifactType: 'ai-runner', artifactVersion: 'v1.0.0',
    dockerImage: 'img:v1', status: 'ONLINE', healthStatus: 'GREEN', hasUpdate: false,
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
  },
  {
    id: '2', name: 'deploy-beta', providerSlug: 'runpod', providerMode: 'serverless',
    gpuModel: 'T4', gpuVramGb: 16, gpuCount: 1, artifactType: 'scope', artifactVersion: 'v2.0.0',
    dockerImage: 'img:v2', status: 'FAILED', healthStatus: 'RED', hasUpdate: true,
    latestAvailableVersion: 'v3.0.0', createdAt: '2026-01-02', updatedAt: '2026-01-02',
  },
];

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DeploymentList', () => {
  it('should render heading', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: mockDeployments }),
    });
    render(<DeploymentList />);
    expect(screen.getByText('Deployments')).toBeInTheDocument();
  });

  it('should show loading state initially', () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: [] }),
    });
    render(<DeploymentList />);
    expect(screen.getByText('Loading deployments...')).toBeInTheDocument();
  });

  it('should show empty state when no deployments', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: [] }),
    });
    render(<DeploymentList />);
    await waitFor(() => {
      expect(screen.getByText('No deployments yet')).toBeInTheDocument();
    });
  });

  it('should render deployment cards', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: mockDeployments }),
    });
    render(<DeploymentList />);
    await waitFor(() => {
      expect(screen.getByText('deploy-alpha')).toBeInTheDocument();
      expect(screen.getByText('deploy-beta')).toBeInTheDocument();
    });
  });

  it('should show status badges', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: mockDeployments }),
    });
    render(<DeploymentList />);
    await waitFor(() => {
      expect(screen.getByText('ONLINE')).toBeInTheDocument();
      expect(screen.getByText('FAILED')).toBeInTheDocument();
    });
  });

  it('should show Refresh button', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: [] }),
    });
    render(<DeploymentList />);
    expect(screen.getByText('Refresh')).toBeInTheDocument();
  });

  it('should show New Deployment button', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: [] }),
    });
    render(<DeploymentList />);
    expect(screen.getByText('New Deployment')).toBeInTheDocument();
  });

  it('should show provider info in cards', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: mockDeployments }),
    });
    render(<DeploymentList />);
    await waitFor(() => {
      expect(screen.getByText('fal-ai')).toBeInTheDocument();
      expect(screen.getByText('runpod')).toBeInTheDocument();
    });
  });

  it('should dispatch navigate event when deployment card is clicked', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: mockDeployments }),
    });
    const handler = vi.fn();
    window.addEventListener('naap:navigate', handler as EventListener);

    render(<DeploymentList />);
    await waitFor(() => {
      expect(screen.getByText('deploy-alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('deploy-alpha'));
    expect(handler).toHaveBeenCalled();
    window.removeEventListener('naap:navigate', handler as EventListener);
  });

  it('should call refresh when Refresh button is clicked', async () => {
    let callCount = 0;
    (global.fetch as any).mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        json: async () => ({ success: true, data: mockDeployments }),
      });
    });

    render(<DeploymentList />);
    await waitFor(() => {
      expect(screen.getByText('deploy-alpha')).toBeInTheDocument();
    });

    const initialCount = callCount;
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => {
      expect(callCount).toBeGreaterThan(initialCount);
    });
  });

  it('should dispatch navigate event when New Deployment is clicked', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: [] }),
    });
    const handler = vi.fn();
    window.addEventListener('naap:navigate', handler as EventListener);

    render(<DeploymentList />);
    await waitFor(() => {
      expect(screen.getByText('New Deployment')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('New Deployment'));
    expect(handler).toHaveBeenCalled();
    window.removeEventListener('naap:navigate', handler as EventListener);
  });

  it('should show error state', async () => {
    (global.fetch as any).mockRejectedValue(new Error('Network error'));
    render(<DeploymentList />);
    await waitFor(() => {
      expect(screen.getByText(/Error: Network error/)).toBeInTheDocument();
    });
  });

  it('should show GPU info in cards', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: mockDeployments }),
    });
    render(<DeploymentList />);
    await waitFor(() => {
      expect(screen.getByText(/A100 \(80GB\)/)).toBeInTheDocument();
      expect(screen.getByText(/T4 \(16GB\)/)).toBeInTheDocument();
    });
  });

  it('should handle mouse hover on deployment cards', async () => {
    (global.fetch as any).mockResolvedValue({
      json: async () => ({ success: true, data: mockDeployments }),
    });
    render(<DeploymentList />);
    await waitFor(() => {
      expect(screen.getByText('deploy-alpha')).toBeInTheDocument();
    });

    const card = screen.getByText('deploy-alpha').closest('div[style]')!;
    fireEvent.mouseEnter(card);
    fireEvent.mouseLeave(card);
  });
});
