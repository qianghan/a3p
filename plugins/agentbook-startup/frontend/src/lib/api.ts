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
  getAddOnTeaser: async (): Promise<AddOnPriceTeaser> =>
    json<AddOnPriceTeaser>(await fetch('/api/v1/agentbook-billing/me/addons?code=startup_tax_benefits&region=us')),
};

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString()}`;
}
