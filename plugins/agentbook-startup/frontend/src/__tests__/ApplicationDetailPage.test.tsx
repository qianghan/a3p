import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ApplicationDetailPage } from '../pages/ApplicationDetailPage';

const getApplication = vi.fn();
const uploadDocument = vi.fn();
const triggerDraft = vi.fn();
const respondToDecisionPoint = vi.fn();

vi.mock('../lib/api', () => ({
  startupApi: {
    getApplication: (...a: unknown[]) => getApplication(...a),
    uploadDocument: (...a: unknown[]) => uploadDocument(...a),
    triggerDraft: (...a: unknown[]) => triggerDraft(...a),
    respondToDecisionPoint: (...a: unknown[]) => respondToDecisionPoint(...a),
  },
  formatCents: (cents: number) => `$${(cents / 100).toLocaleString()}`,
}));

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/applications/${id}`]}>
      <Routes><Route path="/applications/:id" element={<ApplicationDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getApplication.mockReset(); uploadDocument.mockReset(); triggerDraft.mockReset(); respondToDecisionPoint.mockReset();
});

describe('ApplicationDetailPage', () => {
  it('shows the draft sections and an approve/reject decision point', async () => {
    getApplication.mockResolvedValue({
      application: { id: 'app-1', status: 'decision_pending', draft: { programCode: 'us_rd_credit_41', sections: { 'Qualified Research Expenses': [{ label: 'Annual R&D spend', value: 4000, sourceType: 'book_entry' }] }, completeness: 0.5 } },
      documents: [],
      decisionPoints: [{ id: 'dp-1', sequenceOrder: 1, kind: 'approval', prompt: 'Confirm the four-part test.', options: ['approve', 'reject'], response: null, respondedAt: null, blocksProgress: true }],
      auditReview: null,
      program: null,
    });
    renderAt('app-1');
    await waitFor(() => expect(getApplication).toHaveBeenCalledWith('app-1'));
    expect(await screen.findByText(/Confirm the four-part test/i)).toBeTruthy();
    expect(screen.getByText(/Annual R&D spend/i)).toBeTruthy();
    expect(screen.getByText(/\$4,000/)).toBeTruthy();
  });

  it('submits an approval decision-point response and re-fetches the application', async () => {
    getApplication.mockResolvedValue({
      application: { id: 'app-1', status: 'decision_pending', draft: { programCode: 'us_rd_credit_41', sections: {}, completeness: 0 } },
      documents: [],
      decisionPoints: [{ id: 'dp-1', sequenceOrder: 1, kind: 'approval', prompt: 'Confirm the four-part test.', options: ['approve', 'reject'], response: null, respondedAt: null, blocksProgress: true }],
      auditReview: null,
      program: null,
    });
    respondToDecisionPoint.mockResolvedValue({});
    renderAt('app-1');
    await screen.findByText(/Confirm the four-part test/i);
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(respondToDecisionPoint).toHaveBeenCalledWith('dp-1', 'approve'));
    await waitFor(() => expect(getApplication).toHaveBeenCalledTimes(2));
  });

  it('submits a key_input decision-point response', async () => {
    getApplication.mockResolvedValue({
      application: { id: 'app-1', status: 'decision_pending', draft: { programCode: 'us_qsbs_tracking', sections: {}, completeness: 0 } },
      documents: [],
      decisionPoints: [{ id: 'dp-2', sequenceOrder: 1, kind: 'key_input', prompt: 'Enter the share issuance date.', options: null, response: null, respondedAt: null, blocksProgress: true }],
      auditReview: null,
      program: null,
    });
    respondToDecisionPoint.mockResolvedValue({});
    renderAt('app-1');
    await screen.findByText(/Enter the share issuance date/i);
    fireEvent.change(screen.getByLabelText(/your answer/i), { target: { value: '2024-03-15' } });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    await waitFor(() => expect(respondToDecisionPoint).toHaveBeenCalledWith('dp-2', '2024-03-15'));
  });

  it('does not show already-answered decision points as pending', async () => {
    getApplication.mockResolvedValue({
      application: { id: 'app-1', status: 'ready_for_review', draft: { programCode: 'us_rd_credit_41', sections: {}, completeness: 1 } },
      documents: [],
      decisionPoints: [{ id: 'dp-1', sequenceOrder: 1, kind: 'approval', prompt: 'Confirm the four-part test.', options: ['approve', 'reject'], response: 'approve', respondedAt: '2026-01-01', blocksProgress: true }],
      auditReview: null,
      program: null,
    });
    renderAt('app-1');
    await waitFor(() => expect(getApplication).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('shows the "Run audit review" action once the draft reaches ready_for_review, and the "ready to file" banner once audit_reviewed', async () => {
    getApplication.mockResolvedValue({
      application: { id: 'app-1', status: 'ready_for_review', draft: { programCode: 'us_rd_credit_41', sections: {}, completeness: 1 } },
      documents: [],
      decisionPoints: [],
      auditReview: null,
      program: null,
    });
    renderAt('app-1');
    expect(await screen.findByRole('button', { name: /run audit review/i })).toBeTruthy();
    expect(screen.queryByText(/passed audit review/i)).toBeNull();

    getApplication.mockResolvedValue({
      application: { id: 'app-1', status: 'audit_reviewed', draft: { programCode: 'us_rd_credit_41', sections: {}, completeness: 1 } },
      documents: [],
      decisionPoints: [],
      auditReview: { id: 'r1', applicationId: 'app-1', riskLevel: 'low', findings: [], overrides: [], reviewedAt: '2026-01-01', modelVersion: 'us-audit-v1' },
      program: { name: 'Federal R&D Tax Credit (IRC §41)', authority: 'IRS', sourceUrl: 'https://www.irs.gov/forms-pubs/about-form-6765' },
    });
    renderAt('app-1');
    expect(await screen.findByText(/passed audit review/i)).toBeTruthy();
  });

  it('shows the document checklist from server data alone, with no router state (story C5: survives a refresh/direct visit)', async () => {
    getApplication.mockResolvedValue({
      application: { id: 'app-1', status: 'docs_pending', draft: { programCode: 'us_rd_credit_41', sections: {}, completeness: 0 } },
      documents: [],
      decisionPoints: [],
      documentChecklist: [{ docType: 'payroll_register', label: 'Payroll register', description: 'Wages paid.', required: true }],
      auditReview: null,
      program: null,
    });
    // No `state` passed to MemoryRouter's initialEntries — simulates a page
    // load with zero router history (refresh, bookmark, direct navigation).
    render(
      <MemoryRouter initialEntries={[{ pathname: '/applications/app-1' }]}>
        <Routes><Route path="/applications/:id" element={<ApplicationDetailPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Payroll register/i)).toBeTruthy();
  });
});
