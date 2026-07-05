import { describe, it, expect } from 'vitest';
import { filterByAddOn, PLUGIN_REQUIRED_ADDON } from '../addon-gate';

const P = (name: string) => ({ name });

describe('filterByAddOn', () => {
  const map = {
    agentbookscholarship: 'student_success',
    agentbookcareer: 'student_success',
  };

  it('default-open: a plugin with no required add-on always passes', () => {
    const plugins = [P('agentbook-core'), P('agentbook-expense')];
    const out = filterByAddOn(plugins, map, new Set());
    expect(out.map((p) => p.name)).toEqual(['agentbook-core', 'agentbook-expense']);
  });

  it('hides a gated plugin when the tenant owns no add-ons', () => {
    const plugins = [P('agentbook-core'), P('agentbook-scholarship')];
    const out = filterByAddOn(plugins, map, new Set());
    expect(out.map((p) => p.name)).toEqual(['agentbook-core']);
  });

  it('shows a gated plugin when the tenant owns the required add-on', () => {
    const plugins = [P('agentbook-core'), P('agentbook-scholarship'), P('agentbook-career')];
    const out = filterByAddOn(plugins, map, new Set(['student_success']));
    expect(out.map((p) => p.name)).toEqual([
      'agentbook-core',
      'agentbook-scholarship',
      'agentbook-career',
    ]);
  });

  it('owning a different add-on does not unlock the gated plugin', () => {
    const plugins = [P('agentbook-scholarship')];
    const out = filterByAddOn(plugins, map, new Set(['startup_tax_benefits']));
    expect(out).toHaveLength(0);
  });

  it('matches names irrespective of hyphen/underscore/case', () => {
    // map key is normalized ("agentbookscholarship"); plugin names vary.
    const variants = [P('agentbook-scholarship'), P('agentbook_scholarship'), P('AgentbookScholarship')];
    const withoutAddon = filterByAddOn(variants, map, new Set());
    expect(withoutAddon).toHaveLength(0); // all three gated + hidden
    const withAddon = filterByAddOn(variants, map, new Set(['student_success']));
    expect(withAddon).toHaveLength(3); // all three unlocked
  });

  it('production map gates only student plugins, never the existing free/core ones', () => {
    // Non-regression guard: whatever is in the real map, the existing
    // plugins (core, startup, community, etc.) are never gated by it.
    const existing = [P('agentbook-core'), P('agentbook-startup'), P('agentbook-tax'), P('community')];
    const out = filterByAddOn(existing, PLUGIN_REQUIRED_ADDON, new Set());
    expect(out).toHaveLength(existing.length);
  });

  it('production map hides agentbook-scholarship without the student_success add-on', () => {
    const withoutAddon = filterByAddOn([P('agentbook-scholarship')], PLUGIN_REQUIRED_ADDON, new Set());
    expect(withoutAddon).toHaveLength(0);
    const withAddon = filterByAddOn([P('agentbook-scholarship')], PLUGIN_REQUIRED_ADDON, new Set(['student_success']));
    expect(withAddon).toHaveLength(1);
  });
});
