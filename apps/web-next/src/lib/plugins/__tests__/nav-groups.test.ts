import { describe, it, expect } from 'vitest';
import { pluginNavGroup, PLUGIN_NAV_GROUP, NAV_GROUP_LABEL } from '../nav-groups';

describe('pluginNavGroup', () => {
  it('assigns the core accounting plugins to accounting', () => {
    expect(pluginNavGroup('agentbookexpense')).toBe('accounting');
    expect(pluginNavGroup('agentbookinvoice')).toBe('accounting');
    expect(pluginNavGroup('agentbooktax')).toBe('accounting');
  });

  it('assigns the business-type-gated plugins to for-your-business', () => {
    expect(pluginNavGroup('agentbookstartup')).toBe('for-your-business');
    expect(pluginNavGroup('agentbookscholarship')).toBe('for-your-business');
    expect(pluginNavGroup('agentbookcareer')).toBe('for-your-business');
    expect(pluginNavGroup('agentbookhousing')).toBe('for-your-business');
  });

  it('assigns community to advisors-community', () => {
    expect(pluginNavGroup('community')).toBe('advisors-community');
  });

  it('defaults an unrecognized plugin to accounting rather than dropping it silently', () => {
    expect(pluginNavGroup('somefutureplugin')).toBe('accounting');
  });

  it('production map covers every plugin currently in the registry except agentbook-core (rendered separately as Dashboard)', () => {
    expect(Object.keys(PLUGIN_NAV_GROUP).sort()).toEqual(
      [
        'agentbookexpense',
        'agentbookinvoice',
        'agentbooktax',
        'agentbookstartup',
        'agentbookscholarship',
        'agentbookcareer',
        'agentbookhousing',
        'community',
      ].sort(),
    );
  });

  it('has a display label for every group id the map can produce', () => {
    const groupIds = new Set(Object.values(PLUGIN_NAV_GROUP));
    groupIds.add('personal'); // native-only group, never assigned to a plugin
    groupIds.add('resources'); // native-only group, never assigned to a plugin
    for (const id of groupIds) {
      expect(NAV_GROUP_LABEL[id]).toBeTruthy();
    }
  });
});
