import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { createPlugin } from '@naap/plugin-sdk';
import { ScholarshipPage } from './pages/ScholarshipPage';
import './globals.css';

// Non-core plugin: the shell mounts it under /plugins/agentbook-scholarship
// (see the startup plugin's App.tsx note). One page for now — list +
// discovery + per-item consulting, same shape as the other student plugins.
const AgentbookScholarshipApp: React.FC = () => (
  <MemoryRouter initialEntries={['/']}>
    <Routes>
      <Route path="*" element={<ScholarshipPage />} />
    </Routes>
  </MemoryRouter>
);

const plugin = createPlugin({
  name: 'agentbook-scholarship',
  version: '1.0.0',
  routes: ['/plugins/agentbook-scholarship', '/plugins/agentbook-scholarship/*'],
  App: AgentbookScholarshipApp,
});

export const mount = plugin.mount;
export const unmount = plugin.unmount;
export default plugin;
