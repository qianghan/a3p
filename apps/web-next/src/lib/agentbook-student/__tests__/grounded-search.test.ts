import { describe, it, expect } from 'vitest';
import { extractGroundedCandidates } from '../grounded-search';

interface C { title: string; sourceUrl: string }
const hosts = new Set<string>();

describe('extractGroundedCandidates', () => {
  it('parses a clean fenced JSON array', () => {
    const t = '```json\n[\n {"title":"A","sourceUrl":"https://a.edu/x"},\n {"title":"B","sourceUrl":"https://b.org/y"}\n]\n```';
    const r = extractGroundedCandidates<C>(t, hosts, 12);
    expect(r.map((x) => x.title)).toEqual(['A', 'B']);
  });

  it('finds objects buried in verbose prose with citation markers', () => {
    const t = 'Here are results [1] I found. Some intro.\n[\n {"title":"A","sourceUrl":"https://a.edu/x"} ]\nMore notes [2].';
    const r = extractGroundedCandidates<C>(t, hosts, 12);
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('A');
  });

  it('salvages complete objects when the tail is truncated', () => {
    const t = '[{"title":"A","sourceUrl":"https://a.edu/x"},{"title":"B","sourceUrl":"https://b.org/y"},{"title":"C","sourceUrl":"https://c.edu/inc';
    const r = extractGroundedCandidates<C>(t, hosts, 12);
    expect(r.map((x) => x.title)).toEqual(['A', 'B']);
  });

  it('handles brackets/braces inside string values', () => {
    const t = '[{"title":"A [special] {edge}","sourceUrl":"https://a.edu/x?q=1&z=2"}]';
    const r = extractGroundedCandidates<C>(t, hosts, 12);
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe('A [special] {edge}');
  });

  it('drops objects lacking a title or a valid sourceUrl', () => {
    const t = '[{"note":"no title"},{"title":"B","sourceUrl":"not a url"},{"title":"C","sourceUrl":"https://c.edu/ok"}]';
    const r = extractGroundedCandidates<C>(t, hosts, 12);
    expect(r.map((x) => x.title)).toEqual(['C']);
  });

  it('prefers grounded-host matches but falls back to well-formed when none match', () => {
    const t = '[{"title":"A","sourceUrl":"https://a.edu/x"},{"title":"B","sourceUrl":"https://b.org/y"}]';
    // grounded set names b.org only → strict tier returns just B
    expect(extractGroundedCandidates<C>(t, new Set(['b.org']), 12).map((x) => x.title)).toEqual(['B']);
    // grounded set matches nothing → fall back to all well-formed
    expect(extractGroundedCandidates<C>(t, new Set(['nope.com']), 12).map((x) => x.title)).toEqual(['A', 'B']);
  });

  it('returns [] for text with no objects', () => {
    expect(extractGroundedCandidates<C>('no json here at all', hosts, 12)).toEqual([]);
  });
});
