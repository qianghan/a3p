import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { createPlugin } from '@naap/plugin-sdk';
import { StartupDiscoveryPage } from './pages/StartupDiscoveryPage';
import './globals.css';

// Non-core plugins (isCore: false in plugin.json) are namespaced under
// /plugins/{dirName} by packages/database/src/plugin-discovery.ts's
// normalizePluginRoutes() — the shell ignores plugin.json's own "routes"
// list for non-core plugins and always mounts here instead. Confirmed via
// bin/sync-plugin-registry.ts output during PR 7.3 verification.
function getInitialPath(): string {
  if (typeof window === 'undefined') return '/';
  const path = window.location.pathname.replace(/^\/plugins\/agentbook-startup/, '') || '/';
  return path === '' ? '/' : path;
}

const AgentbookStartupApp: React.FC = () => (
  <MemoryRouter initialEntries={[getInitialPath()]}>
    <Routes>
      <Route path="/*" element={<StartupDiscoveryPage />} />
    </Routes>
  </MemoryRouter>
);

const plugin = createPlugin({
  name: 'agentbook-startup',
  version: '1.0.0',
  routes: ['/plugins/agentbook-startup', '/plugins/agentbook-startup/*'],
  App: AgentbookStartupApp,
});

export const mount = plugin.mount;
export const unmount = plugin.unmount;
export default plugin;
