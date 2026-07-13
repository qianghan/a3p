import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isUrlLive, filterLiveCandidates } from '../link-check';

describe('isUrlLive', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('is live when HEAD returns 200', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 200 });
    expect(await isUrlLive('https://example.com/real-page')).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith('https://example.com/real-page', expect.objectContaining({ method: 'HEAD' }));
  });

  it('treats a 3xx redirect as live', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 301 });
    expect(await isUrlLive('https://example.com/moved')).toBe(true);
  });

  it('is dead when both HEAD and the GET fallback 404', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ status: 404 })
      .mockResolvedValueOnce({ status: 404 });
    expect(await isUrlLive('https://example.com/gone')).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to GET when HEAD is rejected (405) but the page really loads', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ status: 405 })
      .mockResolvedValueOnce({ status: 200 });
    expect(await isUrlLive('https://example.com/head-not-allowed')).toBe(true);
  });

  it('falls back to GET when HEAD throws (network error/timeout)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ status: 200 });
    expect(await isUrlLive('https://example.com/flaky-head')).toBe(true);
  });

  it('is dead when both HEAD and GET throw', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('dns failure'))
      .mockRejectedValueOnce(new Error('dns failure'));
    expect(await isUrlLive('https://this-domain-does-not-exist.invalid')).toBe(false);
  });
});

describe('filterLiveCandidates', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('keeps only candidates whose sourceUrl resolves, preserving order', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('dead')) return { status: 404 };
      return { status: 200 };
    });
    const candidates = [
      { title: 'A', sourceUrl: 'https://example.com/a-live' },
      { title: 'B', sourceUrl: 'https://example.com/b-dead' },
      { title: 'C', sourceUrl: 'https://example.com/c-live' },
    ];
    const result = await filterLiveCandidates(candidates, (c) => c.sourceUrl, { concurrency: 2 });
    expect(result.map((c) => c.title)).toEqual(['A', 'C']);
  });

  it('returns an empty array when every candidate is dead', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 404 });
    const candidates = [{ title: 'A', sourceUrl: 'https://example.com/dead-1' }];
    const result = await filterLiveCandidates(candidates, (c) => c.sourceUrl);
    expect(result).toEqual([]);
  });

  it('handles an empty input without making any requests', async () => {
    const result = await filterLiveCandidates<{ sourceUrl: string }>([], (c) => c.sourceUrl);
    expect(result).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
