import { describe, it, expect } from 'vitest';
import { filterByBusinessType, PLUGIN_RELEVANT_BUSINESS_TYPES } from '../business-type-gate';

const P = (name: string) => ({ name });

describe('filterByBusinessType', () => {
  const map = {
    agentbookscholarship: ['student'],
    agentbookstartup: ['startup'],
  };

  it('default-open: a plugin with no relevant-types entry always passes', () => {
    const plugins = [P('agentbook-core'), P('agentbook-expense')];
    const out = filterByBusinessType(plugins, map, 'freelancer');
    expect(out.map((p) => p.name)).toEqual(['agentbook-core', 'agentbook-expense']);
  });

  it('hides a gated plugin when the business type does not match', () => {
    const plugins = [P('agentbook-core'), P('agentbook-scholarship')];
    const out = filterByBusinessType(plugins, map, 'freelancer');
    expect(out.map((p) => p.name)).toEqual(['agentbook-core']);
  });

  it('shows a gated plugin when the business type matches', () => {
    const plugins = [P('agentbook-scholarship'), P('agentbook-startup')];
    expect(filterByBusinessType(plugins, map, 'student').map((p) => p.name)).toEqual(['agentbook-scholarship']);
    expect(filterByBusinessType(plugins, map, 'startup').map((p) => p.name)).toEqual(['agentbook-startup']);
  });

  it('fail-closed: hides gated plugins when business type is null/unknown', () => {
    const plugins = [P('agentbook-scholarship'), P('agentbook-startup')];
    const out = filterByBusinessType(plugins, map, null);
    expect(out).toHaveLength(0);
  });

  it('matches names irrespective of hyphen/underscore/case', () => {
    const variants = [P('agentbook-scholarship'), P('agentbook_scholarship'), P('AgentbookScholarship')];
    expect(filterByBusinessType(variants, map, 'freelancer')).toHaveLength(0);
    expect(filterByBusinessType(variants, map, 'student')).toHaveLength(3);
  });

  it('production map: student plugins are relevant only to student, startup plugin only to startup', () => {
    const plugins = [P('agentbook-scholarship'), P('agentbook-career'), P('agentbook-housing'), P('agentbook-startup')];
    const forStudent = filterByBusinessType(plugins, PLUGIN_RELEVANT_BUSINESS_TYPES, 'student');
    expect(forStudent.map((p) => p.name).sort()).toEqual(
      ['agentbook-career', 'agentbook-housing', 'agentbook-scholarship'].sort(),
    );
    const forStartup = filterByBusinessType(plugins, PLUGIN_RELEVANT_BUSINESS_TYPES, 'startup');
    expect(forStartup.map((p) => p.name)).toEqual(['agentbook-startup']);
  });

  it('production map never gates unrelated plugins (core, tax, expense, community)', () => {
    const existing = [P('agentbook-core'), P('agentbook-tax'), P('agentbook-expense'), P('community')];
    const out = filterByBusinessType(existing, PLUGIN_RELEVANT_BUSINESS_TYPES, 'student');
    expect(out).toHaveLength(existing.length);
  });
});
