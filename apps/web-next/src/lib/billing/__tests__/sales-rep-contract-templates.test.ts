import { describe, expect, it } from 'vitest';
import { CONTRACT_TEMPLATE_SEEDS, LIABILITY_SECTION_KEYS } from '../sales-rep-contract-templates';

describe('CONTRACT_TEMPLATE_SEEDS', () => {
  it('seeds exactly the four supported jurisdictions', () => {
    expect(CONTRACT_TEMPLATE_SEEDS.map((s) => s.jurisdiction).sort()).toEqual(['au', 'ca', 'uk', 'us']);
  });

  it('every liability-clause set covers every required section key', () => {
    for (const seed of CONTRACT_TEMPLATE_SEEDS) {
      for (const key of LIABILITY_SECTION_KEYS) {
        expect(seed.liabilityClauses[key]?.title).toBeTruthy();
        expect(seed.liabilityClauses[key]?.body).toBeTruthy();
      }
    }
  });

  it('every bodyTemplate carries the required substitution placeholders', () => {
    const required = ['{{legalName}}', '{{commissionBps}}', '{{commissionPercent}}', '{{signedByName}}', '{{signedAt}}'];
    for (const seed of CONTRACT_TEMPLATE_SEEDS) {
      for (const placeholder of required) {
        expect(seed.bodyTemplate).toContain(placeholder);
      }
    }
  });

  it('every non-US template actually diverges from the US shell (regression: a silently no-op string.replace would leave them identical)', () => {
    const us = CONTRACT_TEMPLATE_SEEDS.find((s) => s.jurisdiction === 'us')!;
    for (const seed of CONTRACT_TEMPLATE_SEEDS) {
      if (seed.jurisdiction === 'us') continue;
      expect(seed.bodyTemplate).not.toEqual(us.bodyTemplate);
    }
  });

  it('assigns the jurisdiction-correct tax form type', () => {
    const byJurisdiction = Object.fromEntries(CONTRACT_TEMPLATE_SEEDS.map((s) => [s.jurisdiction, s.taxFormType]));
    expect(byJurisdiction).toEqual({
      us: '1099-NEC',
      ca: 'T4A',
      uk: 'self_assessment_notice',
      au: 'abn_notice',
    });
  });
});
