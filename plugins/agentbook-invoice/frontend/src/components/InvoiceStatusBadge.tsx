export type InvoiceStatus = 'draft' | 'sent' | 'viewed' | 'overdue' | 'paid' | 'void';

const STATUS_CONFIG: Record<InvoiceStatus, { label: string; className: string }> = {
  draft:   { label: 'Draft',    className: 'bg-muted text-muted-foreground' },
  sent:    { label: 'Issued',   className: 'bg-primary/10 text-primary' },
  viewed:  { label: 'Viewed',   className: 'bg-violet-500/10 text-violet-400' },
  overdue: { label: 'Past Due', className: 'bg-destructive/10 text-destructive' },
  paid:    { label: 'Paid',     className: 'bg-primary/15 text-primary font-semibold' },
  void:    { label: 'Void',     className: 'bg-muted text-muted-foreground/50 line-through' },
};

export function InvoiceStatusBadge({ status }: { status: string }): JSX.Element {
  const cfg = STATUS_CONFIG[status as InvoiceStatus] ?? { label: status, className: 'bg-muted text-muted-foreground' };
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}
