import React from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { createPlugin } from '@naap/plugin-sdk';
import { ChatPage } from './pages/Chat';
import { DashboardPage } from './pages/Dashboard';
import { LedgerPage } from './pages/Ledger';
import { AccountsPage } from './pages/Accounts';
import { ProjectionsPage } from './pages/Projections';
import { OnboardingPage } from './pages/Onboarding';
import { OnboardingChatPage } from './pages/OnboardingChat';
import { CPAPortalPage } from './pages/CPAPortal';
import { AdminConfigPage } from './pages/AdminConfig';
import { AgentsPage } from './pages/Agents';
import { TelegramSettingsPage } from './pages/TelegramSettings';
import { ActivityPage } from './pages/Activity';
import { HomeOfficePage } from './pages/HomeOffice';
import { DeadLetterPage } from './pages/admin/DeadLetter';
import './globals.css';

const AgentBookCoreApp: React.FC = () => (
  <MemoryRouter>
    <Routes>
      <Route path="/" element={<ChatPage />} />
      <Route path="/chat" element={<ChatPage />} />
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="/ledger" element={<LedgerPage />} />
      <Route path="/accounts" element={<AccountsPage />} />
      <Route path="/projections" element={<ProjectionsPage />} />
      {/* G-032 / PR 27: agent-driven onboarding is the new default.
          Legacy 7-step wizard remains accessible at /onboarding/wizard for
          users who explicitly want the form view. */}
      <Route path="/onboarding" element={<OnboardingChatPage />} />
      <Route path="/onboarding/wizard" element={<OnboardingPage />} />
      <Route path="/cpa" element={<CPAPortalPage />} />
      <Route path="/admin" element={<AdminConfigPage />} />
      <Route path="/admin/dead-letter" element={<DeadLetterPage />} />
      <Route path="/agents" element={<AgentsPage />} />
      <Route path="/telegram" element={<TelegramSettingsPage />} />
      <Route path="/activity" element={<ActivityPage />} />
      <Route path="/home-office" element={<HomeOfficePage />} />
      <Route path="/*" element={<ChatPage />} />
    </Routes>
  </MemoryRouter>
);

const plugin = createPlugin({
  name: 'agentbook-core',
  version: '1.0.0',
  routes: ['/agentbook', '/agentbook/*'],
  App: AgentBookCoreApp,
});

export const mount = plugin.mount;
export const unmount = plugin.unmount;
export default plugin;
