'use client';

import { RequireAuth } from '@/contexts/auth-context';
import { AppLayout } from '@/components/layout/app-layout';
import { StandaloneEntryGate } from '@/components/layout/standalone-entry-gate';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RequireAuth>
      {/* An installed app that lands here gets moved to the mobile shell. */}
      <StandaloneEntryGate />
      <AppLayout>{children}</AppLayout>
    </RequireAuth>
  );
}
