import { createPluginConfig } from '@naap/plugin-build/vite';

export default createPluginConfig({
  name: 'agentbook-billing',
  displayName: 'Billing',
  globalName: 'NaapPluginAgentbookBilling',
  defaultCategory: 'platform',
});
