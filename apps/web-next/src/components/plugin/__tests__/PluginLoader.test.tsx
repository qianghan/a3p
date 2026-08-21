import { render, waitFor } from '@testing-library/react';
import { createContext } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginLoader } from '../PluginLoader';
import { useShell } from '@/contexts/shell-context';
import { loadUMDPlugin, mountUMDPlugin } from '@/lib/plugins/umd-loader';
import { getPluginFeatureFlags } from '@/lib/plugins/feature-flags';

vi.mock('@/contexts/shell-context', () => ({
  useShell: vi.fn(),
  // PluginLoader's error state renders a translated "Retry", which pulls in
  // hooks/use-t.ts, which reads this context directly rather than through
  // useShell() (that throws without a provider). A partial mock without it
  // fails at import time, not at assertion time — so the error looks like a
  // broken test rather than a missing mock entry.
  ShellContextReact: createContext(null),
}));

vi.mock('@/lib/plugins/umd-loader', () => ({
  loadUMDPlugin: vi.fn(),
  mountUMDPlugin: vi.fn(),
  isUMDPluginCached: vi.fn(() => false),
  clearUMDPluginCache: vi.fn(),
}));

vi.mock('@/lib/plugins/feature-flags', () => ({
  getPluginFeatureFlags: vi.fn(() => ({ enableSandbox: false })),
}));

describe('PluginLoader', () => {
  const fakeI18n = { locale: 'fr-CA', t: vi.fn(), formatMoney: vi.fn() };

  beforeEach(() => {
    vi.mocked(useShell).mockReturnValue({
      auth: {}, notifications: {}, navigate: vi.fn(), eventBus: {}, theme: {},
      logger: {}, permissions: {}, integrations: {}, capabilities: {},
      api: {}, tenant: {}, team: {}, i18n: fakeI18n,
    } as any);
    vi.mocked(loadUMDPlugin).mockResolvedValue({
      module: { mount: vi.fn() },
    } as any);
    vi.mocked(getPluginFeatureFlags).mockReturnValue({ enableSandbox: false } as any);
  });

  it('passes shell.i18n through to the plugin mount context', async () => {
    render(
      <PluginLoader
        plugin={{
          name: 'agentbook-tax',
          bundleUrl: 'https://cdn.example/agentbook-tax.js',
          globalName: 'NaapPluginAgentbookTax',
        }}
      />
    );

    await waitFor(() => expect(mountUMDPlugin).toHaveBeenCalled());

    const pluginContext = vi.mocked(mountUMDPlugin).mock.calls[0][2] as Record<string, unknown>;
    expect(pluginContext.i18n).toBe(fakeI18n);
  });

  it('still passes i18n through when sandboxing is enabled (default in production)', async () => {
    vi.mocked(getPluginFeatureFlags).mockReturnValue({ enableSandbox: true } as any);

    render(
      <PluginLoader
        plugin={{
          name: 'agentbook-tax',
          bundleUrl: 'https://cdn.example/agentbook-tax.js',
          globalName: 'NaapPluginAgentbookTax',
        }}
      />
    );

    await waitFor(() => expect(mountUMDPlugin).toHaveBeenCalled());

    const pluginContext = vi.mocked(mountUMDPlugin).mock.calls[0][2] as Record<string, unknown>;
    expect(pluginContext.i18n).toBe(fakeI18n);
  });
});
