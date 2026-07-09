import { describe, it, expect, vi, beforeEach } from 'vitest';

const groundedSearch = vi.fn();
vi.mock('@/lib/agentbook-student/grounded-search', () => ({
  groundedSearch: (...a: unknown[]) => groundedSearch(...a),
  extractGroundedCandidates: () => [],
}));

import { discoverJobs } from '../discover';

beforeEach(() => {
  groundedSearch.mockReset();
  groundedSearch.mockResolvedValue({ text: '[]', groundedHosts: new Set() });
});

function promptSentToSearch(): string {
  return groundedSearch.mock.calls[0][0] as string;
}

describe('discoverJobs prompt construction', () => {
  it('includes the student\'s school and program when the profile has them', async () => {
    await discoverJobs({
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
    expect(prompt).toContain('Canada');
    expect(prompt).not.toContain('United States');
  });

  it('names the correct country for every supported jurisdiction, not just us/ca', async () => {
    await discoverJobs({ jurisdiction: 'uk', region: '', school: null, program: null, level: null, visaStatus: null, homeCountry: null });
    expect(promptSentToSearch()).toContain('United Kingdom');

    groundedSearch.mockClear();
    await discoverJobs({ jurisdiction: 'au', region: '', school: null, program: null, level: null, visaStatus: null, homeCountry: null });
    expect(promptSentToSearch()).toContain('Australia');
  });

  it('mentions home country for an international student', async () => {
    await discoverJobs({
      jurisdiction: 'ca',
      region: '',
      school: null,
      program: null,
      level: null,
      visaStatus: 'international',
      homeCountry: 'India',
    });
    const prompt = promptSentToSearch();
    expect(prompt).toContain('international student');
    expect(prompt).toContain('from India');
  });
});
