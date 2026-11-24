import React, { useEffect, useState } from 'react';
import { useI18n } from '@naap/plugin-sdk';

/**
 * PR 2c (spec §5.1): until the tenant restates a tax year, reports say that
 * its legacy purchases still carry GST/HST in expense. The server decides —
 * the note shows only while the restatement preview has eligible rows (so it
 * disappears once applied, and never appears for US or non-registrants).
 */
export const RestatementNote: React.FC = () => {
  const { t } = useI18n();
  const [note, setNote] = useState<{ count: number; year: number } | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch('/api/v1/agentbook-tax/restatement');
        if (!res.ok) return;
        const body = await res.json();
        const count = Number(body?.data?.counts?.eligible ?? 0);
        if (live && body?.success && body.data.applicable && count > 0) setNote({ count, year: Number(body.data.year) });
      } catch {
        /* the note is advisory: never break the report */
      }
    })();
    return () => { live = false; };
  }, []);
  if (!note) return null;
  return (
    <p role="note" data-testid="restatement-note" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
      {t('tax_ui.restatement_note', { count: String(note.count), year: String(note.year) })}
    </p>
  );
};
