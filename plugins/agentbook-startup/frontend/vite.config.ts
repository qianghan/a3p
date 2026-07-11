import { createPluginConfig } from '@naap/plugin-build/vite';

export default createPluginConfig({
  name: 'agentbook-startup',
  displayName: 'Startup Tax Benefits',
  globalName: 'NaapPluginAgentbookStartup',
  defaultCategory: 'finance',
});
