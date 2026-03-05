import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuditTable } from '../../components/AuditTable';

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const mockEntries = [
  {
    id: 'a1',
    deploymentId: 'dep-1',
    action: 'CREATE',
    resource: 'deployment',
    userId: 'user-abcdef1234567890',
    status: 'success',
    createdAt: '2025-06-01T12:00:00Z',
  },
  {
    id: 'a2',
    action: 'DEPLOY',
    resource: 'deployment',
    userId: 'user-xyz9876543210000',
    status: 'failure',
    errorMsg: 'GPU unavailable',
    createdAt: '2025-06-01T12:05:00Z',
  },
];

describe('AuditTable', () => {
  it('shows "No audit entries" when fetch returns empty data', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: [] }),
    });

    render(<AuditTable />);
    expect(screen.getByText('No audit entries')).toBeInTheDocument();
  });

  it('fetches and renders a table with entries', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockEntries }),
    });

    render(<AuditTable />);

    await waitFor(() => {
      expect(screen.getByText('CREATE')).toBeInTheDocument();
    });

    expect(screen.getByText('DEPLOY')).toBeInTheDocument();
    expect(screen.getAllByText('deployment')).toHaveLength(2);
  });

  it('renders table headers', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockEntries }),
    });

    render(<AuditTable />);

    await waitFor(() => {
      expect(screen.getByText('Action')).toBeInTheDocument();
    });

    expect(screen.getByText('Resource')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByText('Time')).toBeInTheDocument();
  });

  it('truncates userId to first 8 chars', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockEntries }),
    });

    render(<AuditTable />);

    await waitFor(() => {
      expect(screen.getByText('user-abc')).toBeInTheDocument();
    });
    expect(screen.getByText('user-xyz')).toBeInTheDocument();
  });

  it('passes deploymentId and limit as query params', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: [] }),
    });

    render(<AuditTable deploymentId="dep-42" limit={10} />);

    await waitFor(() => {
      const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(url).toContain('deploymentId=dep-42');
      expect(url).toContain('limit=10');
    });
  });

  it('applies distinct colors to success and failure statuses', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockEntries }),
    });

    render(<AuditTable />);

    await waitFor(() => {
      expect(screen.getByText('success')).toBeInTheDocument();
    });

    expect(screen.getByText('success')).toHaveStyle({ color: '#16a34a' });
    expect(screen.getByText('failure')).toHaveStyle({ color: '#dc2626' });
  });
});
