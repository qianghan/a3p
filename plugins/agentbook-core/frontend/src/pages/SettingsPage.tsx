import { useEffect, useRef, useState } from 'react';

interface TenantConfig {
  companyName: string | null;
  companyAddress: string | null;
  companyEmail: string | null;
  companyPhone: string | null;
  logoUrl: string | null;
  brandColor: string;
  defaultPaymentTerms: string | null;
  defaultCurrency: string | null;
  invoiceFooterNote: string | null;
  invoiceThankYouMessage: string | null;
}

const PAYMENT_TERMS = [
  { value: 'net-30', label: 'Net 30' },
  { value: 'net-15', label: 'Net 15' },
  { value: 'net-60', label: 'Net 60' },
  { value: 'due-on-receipt', label: 'Due on receipt' },
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'MXN', 'BRL', 'INR'];

async function fetchConfig(): Promise<TenantConfig> {
  const r = await fetch('/api/v1/agentbook-core/tenant-config');
  if (!r.ok) throw new Error(`${r.status}`);
  const { config } = await r.json() as { config: TenantConfig };
  return config;
}

async function saveConfig(patch: Partial<TenantConfig>): Promise<void> {
  const r = await fetch('/api/v1/agentbook-core/tenant-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`Save failed: ${r.status}`);
}

async function uploadLogo(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const r = await fetch('/api/v1/agentbook-core/tenant-config/logo', {
    method: 'POST',
    body: form,
  });
  if (!r.ok) {
    const { error } = await r.json() as { error: string };
    throw new Error(error);
  }
  const { url } = await r.json() as { url: string };
  return url;
}

function ProfilePreview({
  companyName,
  logoUrl,
  brandColor,
  pendingLogoUrl,
}: {
  companyName: string;
  logoUrl: string | null;
  brandColor: string;
  pendingLogoUrl: string | null;
}): JSX.Element {
  const displayLogo = pendingLogoUrl ?? logoUrl;
  return (
    <div className="rounded-lg border bg-white p-4">
      <p className="mb-2 text-xs font-medium text-gray-500 uppercase tracking-wide">
        Invoice header preview
      </p>
      <div
        className="flex items-center gap-3 rounded p-3"
        style={{ borderLeft: `4px solid ${brandColor}` }}
      >
        {displayLogo ? (
          <img src={displayLogo} alt="logo" className="h-10 w-10 rounded object-contain" />
        ) : (
          <div
            className="flex h-10 w-10 items-center justify-center rounded text-white text-xs font-bold"
            style={{ backgroundColor: brandColor }}
          >
            {(companyName || 'CO').slice(0, 2).toUpperCase()}
          </div>
        )}
        <div>
          <div className="font-semibold text-gray-900" style={{ color: brandColor }}>
            {companyName || 'Your Company'}
          </div>
          <div className="text-xs text-gray-500">Invoice header</div>
        </div>
      </div>
    </div>
  );
}

export function SettingsPage(): JSX.Element {
  const [tab, setTab] = useState<'profile' | 'invoice'>('profile');
  const [config, setConfig] = useState<TenantConfig | null>(null);
  const [form, setForm] = useState<TenantConfig | null>(null);
  const [pendingLogoUrl, setPendingLogoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchConfig().then((c) => { setConfig(c); setForm(c); }).catch((e: unknown) => setErr(String(e)));
  }, []);

  const showToast = (msg: string): void => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleLogoChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    const localUrl = URL.createObjectURL(file);
    setPendingLogoUrl(localUrl);
    setUploading(true);
    try {
      const url = await uploadLogo(file);
      setForm((f) => f ? { ...f, logoUrl: url } : f);
      setPendingLogoUrl(null);
      showToast('Logo uploaded');
    } catch (e2: unknown) {
      setErr(String(e2));
      setPendingLogoUrl(null);
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async (): Promise<void> => {
    if (!form) return;
    setSaving(true);
    setErr(null);
    try {
      await saveConfig(form);
      setConfig(form);
      showToast('Settings saved');
    } catch (e2: unknown) {
      setErr(String(e2));
    } finally {
      setSaving(false);
    }
  };

  const set = (patch: Partial<TenantConfig>): void =>
    setForm((f) => f ? { ...f, ...patch } : f);

  if (!form) {
    return (
      <div className="p-6 text-gray-500">
        {err ? `Error: ${err}` : 'Loading settings…'}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-6 text-2xl font-semibold">Settings</h1>

      {/* Tabs */}
      <div className="mb-6 flex border-b">
        {(['profile', 'invoice'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t === 'profile' ? 'Business Profile' : 'Invoice Defaults'}
          </button>
        ))}
      </div>

      {tab === 'profile' && (
        <div className="space-y-5">
          <ProfilePreview
            companyName={form.companyName ?? ''}
            logoUrl={form.logoUrl}
            brandColor={form.brandColor}
            pendingLogoUrl={pendingLogoUrl}
          />

          <div>
            <label className="block text-sm font-medium text-gray-700">Company name</label>
            <input
              type="text"
              value={form.companyName ?? ''}
              onChange={(e) => set({ companyName: e.target.value || null })}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Acme Corp"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Email</label>
            <input
              type="email"
              value={form.companyEmail ?? ''}
              onChange={(e) => set({ companyEmail: e.target.value || null })}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="billing@acme.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Phone</label>
            <input
              type="tel"
              value={form.companyPhone ?? ''}
              onChange={(e) => set({ companyPhone: e.target.value || null })}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="+1 555 000 0000"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Address</label>
            <textarea
              value={form.companyAddress ?? ''}
              onChange={(e) => set({ companyAddress: e.target.value || null })}
              rows={3}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="123 Main St, Suite 100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Logo</label>
            <div className="mt-1 flex items-center gap-3">
              {(pendingLogoUrl ?? form.logoUrl) ? (
                <img
                  src={pendingLogoUrl ?? form.logoUrl ?? ''}
                  alt="logo"
                  className="h-12 w-12 rounded border object-contain"
                />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded border bg-gray-50 text-xs text-gray-400">
                  No logo
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                className="hidden"
                onChange={handleLogoChange}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="rounded-lg border px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                {uploading ? 'Uploading…' : 'Choose file'}
              </button>
              <span className="text-xs text-gray-400">PNG, JPEG, SVG, WebP · max 2MB</span>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Accent colour</label>
            <div className="mt-1 flex items-center gap-3">
              <input
                type="color"
                value={form.brandColor}
                onChange={(e) => set({ brandColor: e.target.value })}
                className="h-9 w-12 cursor-pointer rounded border"
              />
              <input
                type="text"
                value={form.brandColor}
                onChange={(e) => {
                  if (/^#[0-9a-fA-F]{0,6}$/.test(e.target.value)) {
                    set({ brandColor: e.target.value });
                  }
                }}
                className="w-28 rounded-lg border px-3 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>
      )}

      {tab === 'invoice' && (
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700">Default payment terms</label>
            <select
              value={form.defaultPaymentTerms ?? 'net-30'}
              onChange={(e) => set({ defaultPaymentTerms: e.target.value })}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {PAYMENT_TERMS.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Default currency</label>
            <select
              value={form.defaultCurrency ?? 'USD'}
              onChange={(e) => set({ defaultCurrency: e.target.value })}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Invoice footer note
              <span className="ml-1 font-normal text-gray-400">(appears on all invoices)</span>
            </label>
            <textarea
              value={form.invoiceFooterNote ?? ''}
              onChange={(e) => set({ invoiceFooterNote: e.target.value || null })}
              rows={3}
              maxLength={500}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Thank you for your business."
            />
            <p className="mt-1 text-xs text-gray-400">
              {(form.invoiceFooterNote ?? '').length}/500 characters
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Thank-you message
              <span className="ml-1 font-normal text-gray-400">(shown on paid invoices)</span>
            </label>
            <input
              type="text"
              value={form.invoiceThankYouMessage ?? ''}
              onChange={(e) => set({ invoiceThankYouMessage: e.target.value || null })}
              maxLength={200}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Thank you for your payment!"
            />
          </div>
        </div>
      )}

      {/* Save bar */}
      <div className="mt-8 flex items-center justify-between">
        <div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          {toast && <p className="text-sm text-green-600">{toast}</p>}
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
