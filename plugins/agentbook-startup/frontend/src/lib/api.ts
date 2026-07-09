export interface StartupBenefitProfile {
  tenantId: string;
  companyType: string | null;
  incorporatedAt: string | null;
  headcount: number | null;
  annualRdSpendCents: number | null;
  equityRaisedCents: number | null;
}

export interface ProfileInput {
  companyType?: string;
  incorporatedAt?: string;
  headcount?: number;
  annualRdSpendCents?: number;
  equityRaisedCents?: number;
}

export interface ProgramRecommendation {
  programCode: string;
  name: string;
  authority: string;
  sourceUrl: string;
  status: string;
  confidence: number;
  reasoning: string;
  estValueLowCents: number | null;
  estValueHighCents: number | null;
}

export interface RecommendationsResponse {
  jurisdiction: string;
  programs: ProgramRecommendation[];
  message?: string;
}

export interface AddOnPriceTeaser {
  active: boolean;
  price: { tier: string; priceCents: number; currency: string } | null;
}

export interface DocumentRequirement {
  docType: string;
  label: string;
  description: string;
  required: boolean;
}

export interface DraftField {
  label: string;
  value: string | number;
  sourceType: 'book_entry' | 'document' | 'user_input' | 'computed';
  sourceRef?: string;
}

export interface StartupBenefitApplication {
  id: string;
  tenantId: string;
  programId: string;
  status: string;
  draft: { programCode: string; sections: Record<string, DraftField[]>; completeness: number };
  auditRiskLevel: string | null;
  submittedAt: string | null;
  confirmationRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StartupBenefitDocument {
  id: string;
  applicationId: string;
  docType: string;
  blobUrl: string;
  extractedData: Record<string, unknown> | null;
  status: string;
  uploadedAt: string;
}

export interface StartupBenefitDecisionPoint {
  id: string;
  applicationId: string;
  sequenceOrder: number;
  kind: 'approval' | 'key_input';
  prompt: string;
  options: string[] | null;
  response: unknown;
  respondedAt: string | null;
  blocksProgress: boolean;
}

export interface AuditFinding {
  severity: 'low' | 'medium' | 'high';
  issue: string;
  recommendation: string;
  ruleRef: string;
}

export interface AuditOverride {
  findingIndex: number;
  reason: string | null;
  overriddenAt: string;
}

export interface StartupBenefitAuditReview {
  id: string;
  applicationId: string;
  riskLevel: 'low' | 'medium' | 'high';
  findings: AuditFinding[];
  overrides: AuditOverride[];
  reviewedAt: string;
  modelVersion: string;
}

export interface ProgramInfo {
  name: string;
  authority: string;
  sourceUrl: string;
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

export const startupApi = {
  getProfile: async (): Promise<StartupBenefitProfile | null> =>
    (await json<{ profile: StartupBenefitProfile | null }>(await fetch('/api/v1/agentbook-startup/profile'))).profile,
  saveProfile: async (input: ProfileInput): Promise<StartupBenefitProfile> =>
    (await json<{ profile: StartupBenefitProfile }>(await fetch('/api/v1/agentbook-startup/profile', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    }))).profile,
  getRecommendations: async (): Promise<RecommendationsResponse> =>
    json<RecommendationsResponse>(await fetch('/api/v1/agentbook-startup/recommendations')),
  getAddOnTeaser: async (region: string = 'us'): Promise<AddOnPriceTeaser> =>
    json<AddOnPriceTeaser>(await fetch(`/api/v1/agentbook-billing/me/addons?code=startup_tax_benefits&region=${region}`)),
  // The addon pricing catalog is keyed by region (us/ca/uk/au), not currency,
  // so an AU tenant must pass 'au' here to see AUD pricing rather than the
  // US teaser. Falls back to 'us' on any failure — the teaser is cosmetic,
  // not worth failing the page over.
  getTenantJurisdiction: async (): Promise<string> => {
    try {
      const r = await fetch('/api/v1/agentbook-core/tenant-config');
      const j = await r.json();
      return j?.data?.jurisdiction || 'us';
    } catch {
      return 'us';
    }
  },
  createApplication: async (programCode: string): Promise<{ application: StartupBenefitApplication; documentChecklist: DocumentRequirement[] }> =>
    json(await fetch('/api/v1/agentbook-startup/applications', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ programCode }),
    })),
  listApplications: async (): Promise<{ applications: StartupBenefitApplication[] }> =>
    json(await fetch('/api/v1/agentbook-startup/applications')),
  getApplication: async (id: string): Promise<{
    application: StartupBenefitApplication;
    documents: StartupBenefitDocument[];
    decisionPoints: StartupBenefitDecisionPoint[];
    documentChecklist: DocumentRequirement[];
    auditReview: StartupBenefitAuditReview | null;
    program: ProgramInfo | null;
  }> =>
    json(await fetch(`/api/v1/agentbook-startup/applications/${id}`)),
  uploadDocument: async (applicationId: string, docType: string, file: File): Promise<{ document: StartupBenefitDocument }> => {
    const form = new FormData();
    form.append('docType', docType);
    form.append('file', file);
    return json(await fetch(`/api/v1/agentbook-startup/applications/${applicationId}/documents`, { method: 'POST', body: form }));
  },
  triggerDraft: async (applicationId: string): Promise<{ application: StartupBenefitApplication; decisionPoints: StartupBenefitDecisionPoint[] }> =>
    json(await fetch(`/api/v1/agentbook-startup/applications/${applicationId}/draft`, { method: 'POST' })),
  respondToDecisionPoint: async (decisionPointId: string, response: string): Promise<{ application: StartupBenefitApplication; decisionPoints: StartupBenefitDecisionPoint[] }> =>
    json(await fetch(`/api/v1/agentbook-startup/decision-points/${decisionPointId}/respond`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response }),
    })),
  runAuditReview: async (applicationId: string): Promise<{ application: StartupBenefitApplication; auditReview: StartupBenefitAuditReview }> =>
    json(await fetch(`/api/v1/agentbook-startup/applications/${applicationId}/audit-review`, { method: 'POST' })),
  overrideAuditFinding: async (applicationId: string, findingIndex: number, reason?: string): Promise<{ application: StartupBenefitApplication; auditReview: StartupBenefitAuditReview }> =>
    json(await fetch(`/api/v1/agentbook-startup/applications/${applicationId}/audit-review/override`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ findingIndex, reason }),
    })),
};

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString()}`;
}
