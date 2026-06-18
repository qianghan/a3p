// plugins/agentbook-invoice/frontend/src/components/InvoiceStatusBadge.tsx

export type InvoiceStatus = 'draft' | 'sent' | 'viewed' | 'overdue' | 'paid' | 'void';

const STATUS_CONFIG: Record<
  InvoiceStatus,
  { label: string; className: string }
> = {
  draft:   { label: 'Draft',    className: 'bg-gray-100 text-gray-600' },
  sent:    { label: 'Issued',   className: 'bg-blue-100 text-blue-700' },
  viewed:  { label: 'Viewed',   className: 'bg-indigo-100 text-indigo-700' },
  overdue: { label: 'Past Due', className: 'bg-red-100 text-red-700' },
  paid:    { label: 'Paid',     className: 'bg-green-100 text-green-700' },
  void:    { label: 'Void',     className: 'bg-gray-100 text-gray-400 line-through' },
};

export function InvoiceStatusBadge({ status }: { status: string }): JSX.Element {
  const cfg = STATUS_CONFIG[status as InvoiceStatus] ?? { label: status, className: 'bg-gray-100 text-gray-600' };
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}
