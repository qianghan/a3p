import plugin from './App';

const PLUGIN_GLOBAL_NAME = 'NaapPluginAgentbookStartup';

export const mount = plugin.mount;
export const unmount = plugin.unmount;
export const metadata = (plugin as { metadata?: unknown }).metadata ?? { name: 'agentbook-startup', version: '1.0.0' };

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>)[PLUGIN_GLOBAL_NAME] = {
    mount, unmount, metadata,
  };
}

export default { mount, unmount, metadata };
