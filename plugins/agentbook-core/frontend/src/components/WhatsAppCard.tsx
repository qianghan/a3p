import { useI18n } from '@naap/plugin-sdk';
export function WhatsAppCard(): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-3 rounded-xl border border-dashed border-border/50 bg-card px-4 py-3 opacity-50">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500/10 text-lg">💬</div>
      <div className="flex-1">
        <div className="text-sm font-semibold text-muted-foreground">WhatsApp</div>
        <div className="text-xs text-muted-foreground">{t('core_ui.business_api')}</div>
      </div>
      <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">{t('core_ui.coming_soon')}
      </span>
    </div>
  );
}
