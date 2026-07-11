import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { createPlugin } from '@naap/plugin-sdk';
import { CareerPage } from './pages/CareerPage';
import './globals.css';

const AgentbookCareerApp: React.FC = () => (
  <MemoryRouter initialEntries={['/']}>
    <Routes>
      <Route path="*" element={<CareerPage />} />
    </Routes>
  </MemoryRouter>
);

const plugin = createPlugin({
  name: 'agentbook-career',
  version: '1.0.0',
  routes: ['/plugins/agentbook-career', '/plugins/agentbook-career/*'],
  App: AgentbookCareerApp,
});

export const mount = plugin.mount;
export const unmount = plugin.unmount;
export default plugin;
