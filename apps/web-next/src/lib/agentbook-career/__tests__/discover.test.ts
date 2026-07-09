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

import { discoverJobs, type JobCandidate } from '../discover';

beforeEach(() => {
  groundedSearch.mockReset();
  groundedSearch.mockResolvedValue({ text: '[]', groundedHosts: new Set() });
  extractGroundedCandidates.mockReset();
  extractGroundedCandidates.mockReturnValue([]);
  filterLiveCandidates.mockReset();
  filterLiveCandidates.mockImplementation(async (candidates: JobCandidate[]) => candidates);
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

const CTX = { jurisdiction: 'us', region: '', school: null, program: null, level: null, visaStatus: null, homeCountry: null };

function candidate(overrides: Partial<JobCandidate> = {}): JobCandidate {
  return {
    title: 'Test Internship',
    employer: 'Acme Co',
    location: 'Remote',
    compText: '$20/hr',
    deadlineText: null,
    summary: 'A great opportunity.',
    sourceUrl: 'https://example.com/job',
    sourceLabel: 'example.com',
    ...overrides,
  };
}

describe('discoverJobs result quality filters', () => {
  it('drops candidates whose source link does not actually resolve', async () => {
    const live = candidate({ title: 'Live One' });
    const dead = candidate({ title: 'Dead One', sourceUrl: 'https://example.com/404' });
    extractGroundedCandidates.mockReturnValue([live, dead]);
    filterLiveCandidates.mockImplementation(async (candidates: JobCandidate[]) =>
      candidates.filter((c) => c.title === 'Live One'));

    const result = await discoverJobs(CTX);
    expect(result.candidates.map((c) => c.title)).toEqual(['Live One']);
  });

  it('drops postings whose stated application deadline has already passed', async () => {
    const past = candidate({ title: 'Expired', deadlineText: '2020-01-01' });
    const future = candidate({ title: 'Still Open', deadlineText: '2099-01-01' });
    const noDeadline = candidate({ title: 'No Stated Deadline', deadlineText: null });
    extractGroundedCandidates.mockReturnValue([past, future, noDeadline]);

    const result = await discoverJobs(CTX);
    expect(result.candidates.map((c) => c.title).sort()).toEqual(
      ['No Stated Deadline', 'Still Open'].sort(),
    );
  });
});
