import React, { useRef, useState } from 'react';
import { FilePlus2, Camera, MessageSquare } from 'lucide-react';
import { useI18n } from '@naap/plugin-sdk';

export const QuickActionsBar: React.FC = () => {
  const { t } = useI18n();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      // Hand off to the expense receipt-capture endpoint; if it 404s the
      // user is routed to the upload page so they can try again.
      const res = await fetch('/api/v1/agentbook-expense/receipts/upload', { method: 'POST', body: fd });
      if (!res.ok) {
        window.location.href = '/agentbook/expenses/new';
        return;
      }
      window.location.href = '/agentbook/expenses?recent=1';
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <>
      {/* Mobile: sticky bottom bar. Desktop: hidden (header buttons handle it). */}
      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-card/95 backdrop-blur border-t border-border flex items-stretch"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label={t('dashboard.quick_actions')}
      >
        <a href="/agentbook/invoices/new" className="flex-1 flex flex-col items-center justify-center py-3 active:scale-95 transition-transform">
          <FilePlus2 className="w-5 h-5" />
          <span className="text-[11px] mt-0.5">{t('dashboard.new_invoice')}</span>
        </a>
        <button onClick={() => fileRef.current?.click()} disabled={uploading} className="flex-1 flex flex-col items-center justify-center py-3 active:scale-95 transition-transform disabled:opacity-50">
          <Camera className="w-5 h-5" />
          <span className="text-[11px] mt-0.5">{uploading ? t('common.uploading') : t('core_ui.snap')}</span>
        </button>
        <a href="/agentbook/agents" className="flex-1 flex flex-col items-center justify-center py-3 active:scale-95 transition-transform">
          <MessageSquare className="w-5 h-5" />
          <span className="text-[11px] mt-0.5">{t('dashboard.ask')}</span>
        </a>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFile} />
      </nav>
    </>
  );
};
