import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { createPlugin } from '@naap/plugin-sdk';
import { StartupDiscoveryPage } from './pages/StartupDiscoveryPage';
import './globals.css';

function getInitialPath(): string {
  if (typeof window === 'undefined') return '/';
  const path = window.location.pathname.replace(/^\/agentbook\/startup/, '') || '/';
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
  routes: ['/agentbook/startup', '/agentbook/startup/*'],
  App: AgentbookStartupApp,
});

export const mount = plugin.mount;
export const unmount = plugin.unmount;
export default plugin;
