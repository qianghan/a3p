import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditReviewSection } from '../AuditReviewSection';
import { startupApi } from '../../lib/api';

vi.mock('../../lib/api', () => ({
  startupApi: { runAuditReview: vi.fn(), overrideAuditFinding: vi.fn() },
}));

const application = { id: 'app-1', status: 'ready_for_review' } as never;
const program = { name: 'QSBS Eligibility Tracking (IRC §1202)', authority: 'IRS', sourceUrl: 'https://www.irs.gov/pub/irs-pdf/i1202.pdf' };

beforeEach(() => {
  vi.mocked(startupApi.runAuditReview).mockReset();
  vi.mocked(startupApi.overrideAuditFinding).mockReset();
});

describe('AuditReviewSection', () => {
  it('shows a "Run audit review" button when no review exists yet', () => {
    render(<AuditReviewSection application={application} auditReview={null} program={program} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /run audit review/i })).toBeInTheDocument();
  });

  it('triggers the audit review and calls onChange when the button is clicked', async () => {
    vi.mocked(startupApi.runAuditReview).mockResolvedValue({ application, auditReview: { id: 'r1', applicationId: 'app-1', riskLevel: 'low', findings: [], overrides: [], reviewedAt: '2026-01-01', modelVersion: 'us-audit-v1' } });
    const onChange = vi.fn();
    render(<AuditReviewSection application={application} auditReview={null} program={program} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /run audit review/i }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(startupApi.runAuditReview).toHaveBeenCalledWith('app-1');
  });

  it('renders findings with severity, issue, and recommendation text', () => {
    const auditReview = {
      id: 'r1', applicationId: 'app-1', riskLevel: 'high' as const,
      findings: [{ severity: 'high' as const, issue: 'No cap table uploaded.', recommendation: 'Upload it.', ruleRef: 'irs:irc-1202-gross-assets-cap' }],
      overrides: [], reviewedAt: '2026-01-01', modelVersion: 'us-audit-v1',
    };
    render(<AuditReviewSection application={application} auditReview={auditReview} program={program} onChange={vi.fn()} />);
    expect(screen.getByText('No cap table uploaded.')).toBeInTheDocument();
    expect(screen.getByText('Upload it.')).toBeInTheDocument();
  });

  it('requires a non-empty reason before submitting an override for a high-severity finding', () => {
    const auditReview = {
      id: 'r1', applicationId: 'app-1', riskLevel: 'high' as const,
      findings: [{ severity: 'high' as const, issue: 'No cap table uploaded.', recommendation: 'Upload it.', ruleRef: 'irs:irc-1202-gross-assets-cap' }],
      overrides: [], reviewedAt: '2026-01-01', modelVersion: 'us-audit-v1',
    };
    render(<AuditReviewSection application={application} auditReview={auditReview} program={program} onChange={vi.fn()} />);
    const overrideButton = screen.getByRole('button', { name: /override/i });
    expect(overrideButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/reason for overriding/i), { target: { value: 'Verified with counsel.' } });
    expect(overrideButton).not.toBeDisabled();
  });

  it('shows a "Learn more" link to the program source', () => {
    const auditReview = { id: 'r1', applicationId: 'app-1', riskLevel: 'low' as const, findings: [], overrides: [], reviewedAt: '2026-01-01', modelVersion: 'us-audit-v1' };
    render(<AuditReviewSection application={application} auditReview={auditReview} program={program} onChange={vi.fn()} />);
    expect(screen.getByRole('link', { name: /learn more/i })).toHaveAttribute('href', program.sourceUrl);
  });
});
