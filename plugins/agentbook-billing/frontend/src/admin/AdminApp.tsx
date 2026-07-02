import { useState } from 'react';
import { useAuthService } from '@naap/plugin-sdk';
import { PlanList } from './PlanList';
import { TemplatePickerModal } from './TemplatePickerModal';
import { PlanEditorModal } from './PlanEditorModal';
import type { Plan, PlanTemplate } from '../lib/api';

type Modal =
  | null
  | { kind: 'picker' }
  | { kind: 'edit'; plan: Plan }
  | { kind: 'create'; template: PlanTemplate };

// F6-1: this screen (plan management — edit/archive/create-from-template)
// rendered for ANY authenticated user who navigated to /admin/billing, with
// no client-side admin check at all. Every mutating endpoint it calls does
// correctly enforce requireAdmin server-side, so this was a UI-exposure/
// dead-end bug, not a data-mutation risk — but a non-admin clicking "New
// plan from template" hit a 403 with no error handling (see
// TemplatePickerModal's fix) and a permanently stuck "Loading…" modal.
function AdminOnlyMessage(): JSX.Element {
  return (
    <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary, #6b7280)' }}>
      You don&apos;t have permission to manage billing plans.
    </div>
  );
}

export function AdminApp(): JSX.Element {
  const [modal, setModal] = useState<Modal>(null);
  const [refresh, setRefresh] = useState(0);
  const auth = useAuthService();
  const isAdmin = auth.hasRole('system:admin') || auth.hasRole('admin');

  if (!isAdmin) return <AdminOnlyMessage />;

  return (
    <div>
      <PlanList
        key={refresh}
        onAdd={() => setModal({ kind: 'picker' })}
        onEdit={(plan) => setModal({ kind: 'edit', plan })}
      />
      {modal?.kind === 'picker' && (
        <TemplatePickerModal
          onClose={() => setModal(null)}
          onPicked={(t) => setModal({ kind: 'create', template: t })}
        />
      )}
      {modal?.kind === 'create' && (
        <PlanEditorModal
          mode={{ kind: 'create', template: modal.template }}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); setRefresh((r) => r + 1); }}
        />
      )}
      {modal?.kind === 'edit' && (
        <PlanEditorModal
          mode={{ kind: 'edit', plan: modal.plan }}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); setRefresh((r) => r + 1); }}
        />
      )}
    </div>
  );
}
