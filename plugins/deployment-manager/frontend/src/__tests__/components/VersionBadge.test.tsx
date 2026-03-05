import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VersionBadge } from '../../components/VersionBadge';

vi.mock('lucide-react', () => ({
  AlertCircle: (props: any) => <svg data-testid="alert-circle-icon" {...props} />,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VersionBadge', () => {
  it('renders the current version', () => {
    render(<VersionBadge currentVersion="v1.2.0" hasUpdate={false} />);
    expect(screen.getByText('v1.2.0')).toBeInTheDocument();
  });

  it('does not show update badge when hasUpdate is false', () => {
    render(
      <VersionBadge currentVersion="v1.2.0" latestVersion="v1.3.0" hasUpdate={false} />,
    );

    expect(screen.queryByText('v1.3.0 available')).not.toBeInTheDocument();
  });

  it('shows update badge when hasUpdate is true and latestVersion is provided', () => {
    render(
      <VersionBadge currentVersion="v1.2.0" latestVersion="v1.3.0" hasUpdate={true} />,
    );

    expect(screen.getByText('v1.3.0 available')).toBeInTheDocument();
    expect(screen.getByTestId('alert-circle-icon')).toBeInTheDocument();
  });

  it('does not show update badge when hasUpdate is true but latestVersion is missing', () => {
    render(<VersionBadge currentVersion="v1.2.0" hasUpdate={true} />);

    expect(screen.queryByText(/available/)).not.toBeInTheDocument();
  });

  it('renders currentVersion in a monospace font', () => {
    render(<VersionBadge currentVersion="v2.0.0" hasUpdate={false} />);
    const versionSpan = screen.getByText('v2.0.0');
    expect(versionSpan.style.fontFamily).toBe('monospace');
  });
});
