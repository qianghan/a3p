import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DeploymentDetail } from '../../pages/DeploymentDetail';
import { useDeployment } from '../../hooks/useDeployments';
import { useHealthPolling } from '../../hooks/useHealthPolling';
import type { Deployment } from '../../hooks/useDeployments';

vi.mock('lucide-react', () => ({
  ArrowLeft: (props: any) => <svg data-testid="arrow-left" {...props} />,
  RefreshCw: (props: any) => <svg data-testid="refresh-icon" {...props} />,
  Trash2: (props: any) => <svg data-testid="trash-icon" {...props} />,
  ArrowUpCircle: (props: any) => <svg data-testid="update-icon" {...props} />,
  Server: (props: any) => <svg data-testid="server-icon" {...props} />,
  Cpu: (props: any) => <svg data-testid="cpu-icon" {...props} />,
  Terminal: (props: any) => <svg data-testid="terminal-icon" {...props} />,
  AlertCircle: (props: any) => <svg data-testid="alert-circle" {...props} />,
}));

vi.mock('../../hooks/useDeployments');
vi.mock('../../hooks/useHealthPolling');

vi.mock('../../components/HealthIndicator', () => ({
  HealthIndicator: ({ status, showLabel }: any) => (
    <span data-testid="health-indicator">{status}{showLabel ? ' (label)' : ''}</span>
  ),
}));

vi.mock('../../components/VersionBadge', () => ({
  VersionBadge: ({ currentVersion, hasUpdate }: any) => (
    <span data-testid="version-badge">{currentVersion}{hasUpdate ? ' (update)' : ''}</span>
  ),
}));

vi.mock('../../components/StatusTimeline', () => ({
  StatusTimeline: ({ deploymentId }: any) => (
    <div data-testid="status-timeline">Timeline for {deploymentId}</div>
  ),
}));

vi.mock('../../components/AuditTable', () => ({
  AuditTable: ({ deploymentId }: any) => (
    <div data-testid="audit-table">Audit for {deploymentId}</div>
  ),
}));

vi.mock('../../components/DeploymentLogs', () => ({
  DeploymentLogs: ({ deploymentId }: any) => (
    <div data-testid="deployment-logs">Logs for {deploymentId}</div>
  ),
}));

const mockDeployment: Deployment = {
  id: 'dep-1',
  name: 'My AI Worker',
  providerSlug: 'replicate',
  providerMode: 'serverless',
  gpuModel: 'A100',
  gpuVramGb: 80,
  gpuCount: 1,
  artifactType: 'livepeer-ai-worker',
  artifactVersion: 'v0.9.0',
  dockerImage: 'livepeer/ai-worker:v0.9.0',
  status: 'ONLINE',
  healthStatus: 'GREEN',
  endpointUrl: 'https://api.replicate.com/worker/123',
  hasUpdate: false,
  createdAt: '2025-06-01T10:00:00Z',
  updatedAt: '2025-06-01T10:05:00Z',
  lastHealthCheck: '2025-06-01T12:00:00Z',
};

const mockRefresh = vi.fn();

function setupMocks(overrides?: Partial<Deployment> | null, loading = false) {
  const deployment = overrides === null ? null : { ...mockDeployment, ...overrides };
  vi.mocked(useDeployment).mockReturnValue({
    deployment,
    loading,
    refresh: mockRefresh,
  });
  vi.mocked(useHealthPolling).mockReturnValue({
    healthStatus: 'GREEN',
    lastCheck: '2025-06-01T12:00:00Z',
  });
}

beforeEach(() => {
  global.fetch = vi.fn();
  mockRefresh.mockReset();
  setupMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DeploymentDetail', () => {
  it('renders deployment name and provider info', () => {
    render(<DeploymentDetail deploymentId="dep-1" />);

    expect(screen.getByText('My AI Worker')).toBeInTheDocument();
    expect(screen.getByText('replicate')).toBeInTheDocument();
  });

  it('renders info cards with artifact, status, and endpoint', () => {
    render(<DeploymentDetail deploymentId="dep-1" />);

    expect(screen.getByText('livepeer-ai-worker')).toBeInTheDocument();
    expect(screen.getByText('ONLINE')).toBeInTheDocument();
    expect(screen.getByText('https://api.replicate.com/worker/123')).toBeInTheDocument();
  });

  it('renders tab buttons and shows timeline by default', () => {
    render(<DeploymentDetail deploymentId="dep-1" />);

    expect(screen.getByText('Timeline')).toBeInTheDocument();
    expect(screen.getByText('Logs')).toBeInTheDocument();
    expect(screen.getByText('Health')).toBeInTheDocument();
    expect(screen.getByText('Audit Log')).toBeInTheDocument();
    expect(screen.getByTestId('status-timeline')).toBeInTheDocument();
  });

  it('switches to Logs tab when clicked', () => {
    render(<DeploymentDetail deploymentId="dep-1" />);

    fireEvent.click(screen.getByText('Logs'));
    expect(screen.getByTestId('deployment-logs')).toBeInTheDocument();
    expect(screen.queryByTestId('status-timeline')).not.toBeInTheDocument();
  });

  it('switches to Health tab when clicked', () => {
    render(<DeploymentDetail deploymentId="dep-1" />);

    fireEvent.click(screen.getByText('Health'));
    expect(screen.getByText(/Last checked/)).toBeInTheDocument();
  });

  it('switches to Audit Log tab when clicked', () => {
    render(<DeploymentDetail deploymentId="dep-1" />);

    fireEvent.click(screen.getByText('Audit Log'));
    expect(screen.getByTestId('audit-table')).toBeInTheDocument();
  });

  it('renders back-to-deployments button', () => {
    render(<DeploymentDetail deploymentId="dep-1" />);
    expect(screen.getByText('Back to Deployments')).toBeInTheDocument();
  });

  it('renders destroy button for ONLINE deployments', () => {
    render(<DeploymentDetail deploymentId="dep-1" />);
    expect(screen.getByTitle('Destroy')).toBeInTheDocument();
  });

  it('calls fetch with DELETE when destroy is confirmed', async () => {
    window.confirm = vi.fn(() => true);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });

    render(<DeploymentDetail deploymentId="dep-1" />);

    fireEvent.click(screen.getByTitle('Destroy'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/v1/deployment-manager/deployments/dep-1',
        { method: 'DELETE' },
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('does not call fetch when destroy is cancelled', () => {
    window.confirm = vi.fn(() => false);

    render(<DeploymentDetail deploymentId="dep-1" />);
    fireEvent.click(screen.getByTitle('Destroy'));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('shows update button for ONLINE deployments with hasUpdate', () => {
    setupMocks({ hasUpdate: true, latestAvailableVersion: 'v1.0.0' });

    render(<DeploymentDetail deploymentId="dep-1" />);
    expect(screen.getByText('Update')).toBeInTheDocument();
  });

  it('opens update dialog when Update button is clicked', () => {
    setupMocks({ hasUpdate: true, latestAvailableVersion: 'v1.0.0' });

    render(<DeploymentDetail deploymentId="dep-1" />);
    fireEvent.click(screen.getByText('Update'));

    expect(screen.getByText('Update Deployment')).toBeInTheDocument();
    expect(screen.getByText('New Version')).toBeInTheDocument();
    expect(screen.getByText('Apply Update')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('closes update dialog when Cancel is clicked', () => {
    setupMocks({ hasUpdate: true, latestAvailableVersion: 'v1.0.0' });

    render(<DeploymentDetail deploymentId="dep-1" />);
    fireEvent.click(screen.getByText('Update'));
    expect(screen.getByText('Update Deployment')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Update Deployment')).not.toBeInTheDocument();
  });

  it('submits update via PUT and refreshes on success', async () => {
    setupMocks({ hasUpdate: true, latestAvailableVersion: 'v1.0.0' });

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });

    render(<DeploymentDetail deploymentId="dep-1" />);
    fireEvent.click(screen.getByText('Update'));

    const versionInput = screen.getByPlaceholderText('v0.9.0');
    fireEvent.change(versionInput, { target: { value: 'v1.0.0' } });

    fireEvent.click(screen.getByText('Apply Update'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/v1/deployment-manager/deployments/dep-1',
        expect.objectContaining({ method: 'PUT' }),
      );
    });
  });

  it('shows Retry button for FAILED deployments', () => {
    setupMocks({ status: 'FAILED' });

    render(<DeploymentDetail deploymentId="dep-1" />);
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('calls retry endpoint when Retry is clicked', async () => {
    setupMocks({ status: 'FAILED' });

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });

    render(<DeploymentDetail deploymentId="dep-1" />);
    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/v1/deployment-manager/deployments/dep-1/retry',
        { method: 'POST' },
      );
    });
  });

  it('shows loading state when loading is true', () => {
    setupMocks(null, true);

    render(<DeploymentDetail deploymentId="dep-1" />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows "Deployment not found" when deployment is null and not loading', () => {
    setupMocks(null, false);

    render(<DeploymentDetail deploymentId="dep-1" />);
    expect(screen.getByText('Deployment not found')).toBeInTheDocument();
  });

  it('displays SSH host when present', () => {
    setupMocks({ sshHost: '10.0.1.5' });

    render(<DeploymentDetail deploymentId="dep-1" />);
    expect(screen.getByText('SSH: 10.0.1.5')).toBeInTheDocument();
  });

  it('shows N/A when endpointUrl is not set', () => {
    setupMocks({ endpointUrl: undefined });

    render(<DeploymentDetail deploymentId="dep-1" />);
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });
});
