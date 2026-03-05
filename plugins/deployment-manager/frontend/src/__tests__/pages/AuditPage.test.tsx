import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuditPage } from '../../pages/AuditPage';

vi.mock('lucide-react', () => ({
  FileText: (props: any) => <svg data-testid="file-text-icon" {...props} />,
  Filter: (props: any) => <svg data-testid="filter-icon" {...props} />,
}));

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
    resourceId: 'res-abcdef1234567890',
    userId: 'user-abcdef1234567890',
    status: 'success',
    details: { provider: 'replicate' },
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

describe('AuditPage', () => {
  it('shows loading state initially', () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    render(<AuditPage />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders the heading with entry count after data loads', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockEntries, total: 2 }),
    });

    render(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('Audit Log')).toBeInTheDocument();
    });
    expect(screen.getByText('(2 entries)')).toBeInTheDocument();
  });

  it('shows "No audit entries found" when data is empty', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: [], total: 0 }),
    });

    render(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('No audit entries found')).toBeInTheDocument();
    });
  });

  it('renders audit table with entries', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockEntries, total: 2 }),
    });

    render(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('CREATE')).toBeInTheDocument();
    });

    expect(screen.getAllByText('DEPLOY').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('success')).toBeInTheDocument();
    expect(screen.getByText('failure')).toBeInTheDocument();
    expect(screen.getByText('GPU unavailable')).toBeInTheDocument();
  });

  it('displays truncated resourceId when present', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockEntries, total: 2 }),
    });

    render(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('res-abcd...')).toBeInTheDocument();
    });
  });

  it('re-fetches when action filter changes', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockEntries, total: 2 }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: [mockEntries[0]], total: 1 }),
      });

    render(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('CREATE')).toBeInTheDocument();
    });

    const actionSelect = screen.getByDisplayValue('All Actions');
    fireEvent.change(actionSelect, { target: { value: 'CREATE' } });

    await waitFor(() => {
      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const lastUrl = calls[calls.length - 1][0] as string;
      expect(lastUrl).toContain('action=CREATE');
    });
  });

  it('shows pagination when total exceeds limit', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockEntries, total: 60 }),
    });

    render(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    });

    expect(screen.getByText('Previous')).toBeDisabled();
    expect(screen.getByText('Next')).not.toBeDisabled();
  });

  it('navigates to next page on Next click', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockEntries, total: 60 }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockEntries, total: 60 }),
      });

    render(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Next'));

    await waitFor(() => {
      expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    });
  });

  it('navigates to previous page on Previous click', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockEntries, total: 60 }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockEntries, total: 60 }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockEntries, total: 60 }),
      });

    render(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Next'));

    await waitFor(() => {
      expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Previous'));

    await waitFor(() => {
      expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    });
  });

  it('re-fetches when user ID filter changes', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockEntries, total: 2 }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: [mockEntries[0]], total: 1 }),
      });

    render(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('CREATE')).toBeInTheDocument();
    });

    const userInput = screen.getByPlaceholderText('Filter by User ID...');
    fireEvent.change(userInput, { target: { value: 'user-abc' } });

    await waitFor(() => {
      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const lastUrl = calls[calls.length - 1][0] as string;
      expect(lastUrl).toContain('userId=user-abc');
    });
  });

  it('re-fetches when deployment ID filter changes', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: mockEntries, total: 2 }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ success: true, data: [mockEntries[0]], total: 1 }),
      });

    render(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText('CREATE')).toBeInTheDocument();
    });

    const depInput = screen.getByPlaceholderText('Filter by Deployment ID...');
    fireEvent.change(depInput, { target: { value: 'dep-1' } });

    await waitFor(() => {
      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const lastUrl = calls[calls.length - 1][0] as string;
      expect(lastUrl).toContain('deploymentId=dep-1');
    });
  });

  it('renders details column as JSON or em dash', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ success: true, data: mockEntries, total: 2 }),
    });

    render(<AuditPage />);

    await waitFor(() => {
      expect(screen.getByText(/provider/)).toBeInTheDocument();
    });

    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
