import { describe, it, expect, vi, beforeEach } from 'vitest';

const groundedSearch = vi.fn();
const extractGroundedCandidates = vi.fn();
vi.mock('@/lib/agentbook-student/grounded-search', () => ({
  groundedSearch: (...a: unknown[]) => groundedSearch(...a),
  extractGroundedCandidates: (...a: unknown[]) => extractGroundedCandidates(...a),
}));

const filterLiveCandidates = vi.fn();
vi.mock('@/lib/agentbook-student/link-check', () => ({
  filterLiveCandidates: (...a: unknown[]) => filterLiveCandidates(...a),
}));

import { discoverScholarships, type ScholarshipCandidate } from '../discover';

beforeEach(() => {
  groundedSearch.mockReset();
  groundedSearch.mockResolvedValue({ text: '[]', groundedHosts: new Set() });
  extractGroundedCandidates.mockReset();
  extractGroundedCandidates.mockReturnValue([]);
  // Default: pass every candidate through unchanged — individual tests below
  // override this to exercise the actual filtering behavior.
  filterLiveCandidates.mockReset();
  filterLiveCandidates.mockImplementation(async (candidates: ScholarshipCandidate[]) => candidates);
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

const CTX = { jurisdiction: 'us', region: '', school: null, program: null, level: null, visaStatus: null, homeCountry: null };

function candidate(overrides: Partial<ScholarshipCandidate> = {}): ScholarshipCandidate {
  return {
    title: 'Test Scholarship',
    amountText: '$1,000',
    deadlineText: null,
    eligibilitySummary: 'Open to all.',
    sourceUrl: 'https://example.com/scholarship',
    sourceLabel: 'example.com',
    ...overrides,
  };
}

describe('discoverScholarships result quality filters', () => {
  it('drops candidates whose source link does not actually resolve (filterLiveCandidates is consulted)', async () => {
    const live = candidate({ title: 'Live One' });
    const dead = candidate({ title: 'Dead One', sourceUrl: 'https://example.com/404' });
    extractGroundedCandidates.mockReturnValue([live, dead]);
    filterLiveCandidates.mockImplementation(async (candidates: ScholarshipCandidate[]) =>
      candidates.filter((c) => c.title === 'Live One'));

    const result = await discoverScholarships(CTX);
    expect(result.candidates.map((c) => c.title)).toEqual(['Live One']);
  });

  it('drops candidates whose stated deadline has already passed', async () => {
    const past = candidate({ title: 'Expired', deadlineText: '2020-01-01' });
    const future = candidate({ title: 'Still Open', deadlineText: '2099-01-01' });
    const rolling = candidate({ title: 'Rolling Admission', deadlineText: 'Rolling' });
    const noDeadline = candidate({ title: 'No Stated Deadline', deadlineText: null });
    extractGroundedCandidates.mockReturnValue([past, future, rolling, noDeadline]);

    const result = await discoverScholarships(CTX);
    expect(result.candidates.map((c) => c.title).sort()).toEqual(
      ['No Stated Deadline', 'Rolling Admission', 'Still Open'].sort(),
    );
  });

  it('still returns the empty-results note when link/deadline filtering removes everything', async () => {
    extractGroundedCandidates.mockReturnValue([candidate({ deadlineText: '2020-01-01' })]);
    const result = await discoverScholarships(CTX);
    expect(result.candidates).toEqual([]);
    expect(result.note).toMatch(/no matching scholarships/i);
  });
});
