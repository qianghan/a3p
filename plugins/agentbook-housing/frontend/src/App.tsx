import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { createPlugin } from '@naap/plugin-sdk';
import { HousingPage } from './pages/HousingPage';
import './globals.css';

const AgentbookHousingApp: React.FC = () => (
  <MemoryRouter initialEntries={['/']}>
    <Routes>
      <Route path="*" element={<HousingPage />} />
    </Routes>
  </MemoryRouter>
);

const plugin = createPlugin({
  name: 'agentbook-housing',
  version: '1.0.0',
  routes: ['/plugins/agentbook-housing', '/plugins/agentbook-housing/*'],
  App: AgentbookHousingApp,
});

export const mount = plugin.mount;
export const unmount = plugin.unmount;
export default plugin;
