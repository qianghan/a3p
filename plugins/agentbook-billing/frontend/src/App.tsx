import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { createPlugin } from '@naap/plugin-sdk';
import { AdminApp } from './admin/AdminApp';
import { UserApp } from './user/UserApp';

// Map shell URL → in-plugin route. Shell mounts this plugin at either
// /admin/billing or /billing; everything else lands on the user view.
function getInitialRoute(): string {
  if (typeof window === 'undefined') return '/';
  return window.location.pathname.startsWith('/admin/billing') ? '/admin' : '/';
}

const BillingApp: React.FC = () => (
  <MemoryRouter initialEntries={[getInitialRoute()]}>
    <Routes>
      <Route path="/admin/*" element={<AdminApp />} />
      <Route path="/*" element={<UserApp />} />
    </Routes>
  </MemoryRouter>
);

const plugin = createPlugin({
  name: 'agentbook-billing',
  version: '1.0.0',
  routes: ['/admin/billing', '/admin/billing/*', '/billing', '/billing/*'],
  App: BillingApp,
});

export const mount = plugin.mount;
export const unmount = plugin.unmount;
export default plugin;
