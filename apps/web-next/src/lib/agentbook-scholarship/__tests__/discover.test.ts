import { describe, it, expect, vi, beforeEach } from 'vitest';

const groundedSearch = vi.fn();
vi.mock('@/lib/agentbook-student/grounded-search', () => ({
  groundedSearch: (...a: unknown[]) => groundedSearch(...a),
  extractGroundedCandidates: () => [],
}));

import { discoverScholarships } from '../discover';

beforeEach(() => {
  groundedSearch.mockReset();
  groundedSearch.mockResolvedValue({ text: '[]', groundedHosts: new Set() });
});

function promptSentToSearch(): string {
  return groundedSearch.mock.calls[0][0] as string;
}

describe('discoverScholarships prompt construction', () => {
  it('includes the student\'s school, program, and level when the profile has them', async () => {
    await discoverScholarships({
      jurisdiction: 'ca',
      region: 'ON',
      school: 'University of Toronto Scarborough (UTSC)',
      program: 'life science',
      level: "Bachelor's",
      visaStatus: null,
      homeCountry: null,
    });
    const prompt = promptSentToSearch();
    expect(prompt).toContain('University of Toronto Scarborough (UTSC)');
    expect(prompt).toContain('life science');
    expect(prompt).toContain("Bachelor's");
    expect(prompt).toContain('Canada');
    expect(prompt).not.toContain('United States');
  });

  it('names the correct country for every supported jurisdiction, not just us/ca', async () => {
    await discoverScholarships({ jurisdiction: 'uk', region: '', school: null, program: null, level: null, visaStatus: null, homeCountry: null });
    expect(promptSentToSearch()).toContain('United Kingdom');

    groundedSearch.mockClear();
    await discoverScholarships({ jurisdiction: 'au', region: '', school: null, program: null, level: null, visaStatus: null, homeCountry: null });
    expect(promptSentToSearch()).toContain('Australia');
  });

  it('does not silently default a Canadian student to the United States', async () => {
    await discoverScholarships({
      jurisdiction: 'ca',
      region: '',
      school: 'University of Toronto',
      program: null,
      level: null,
      visaStatus: null,
      homeCountry: null,
    });
    const prompt = promptSentToSearch();
    expect(prompt).toContain('Canada');
    expect(prompt).not.toMatch(/\bthe United States\b/);
  });

  it('still mentions the free-text focus query', async () => {
    await discoverScholarships({ jurisdiction: 'ca', region: '', school: null, program: null, level: null, visaStatus: null, homeCountry: null }, 'life science');
    expect(promptSentToSearch()).toContain('Focus: life science');
  });
});
