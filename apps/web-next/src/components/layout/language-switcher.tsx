'use client';

import { useEffect, useRef, useState } from 'react';
import { Languages, Check } from 'lucide-react';
import { offerableLocales } from '@agentbook/i18n/catalog';
import { useShell } from '@/contexts/shell-context';

/**
 * Language switcher for the app shell.
 *
 * A picker also exists in Business Profile settings, but that is three clicks
 * deep — this is the one a user actually finds. Both write the same
 * `AbTenantConfig.locale` field; there is no second source of truth.
 *
 * Options come from `offerableLocales()`, which filters by catalog readiness,
 * so a language whose translations are incomplete is never presented. The list
 * grows on its own when a pack lands.
 *
 * Hidden entirely when only one language is offerable — a one-item picker is
 * noise in the header.
 */

const OPTIONS = offerableLocales();

/** Which offered option represents a stored value like the legacy 'en-CA'. */
function matchOption(stored: string | undefined): string {
  const fallback = OPTIONS[0]?.value ?? 'en-US';
  if (!stored) return fallback;
  const s = stored.toLowerCase();
  const exact = OPTIONS.find((o) => o.value.toLowerCase() === s);
  if (exact) return exact.value;
  const lang = s.split('-')[0];
  return OPTIONS.find((o) => o.value.toLowerCase().split('-')[0] === lang)?.value ?? fallback;
}

export function LanguageSwitcher() {
  const shell = useShell();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stored, setStored] = useState<string | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);

  // Read the tenant's current choice so the menu shows a tick next to it.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/agentbook-core/tenant-config')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j?.data?.locale) setStored(j.data.locale as string);
      })
      .catch(() => {
        // Non-fatal: the switcher still works, it just shows no current tick.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close on outside click and on Escape — a header menu that traps focus or
  // sticks open is worse than no menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // One option is not a choice.
  if (OPTIONS.length < 2) return null;

  const current = matchOption(stored);

  const choose = async (value: string): Promise<void> => {
    if (value === current || saving) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/v1/agentbook-core/tenant-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: value }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setStored(value);
      // The translator is built once at shell mount from the fetched config,
      // so a reload is the honest way to apply the change everywhere at once —
      // including the plugin bundles, which receive it through ShellContext.
      window.location.reload();
    } catch {
      shell?.notifications?.error?.('Could not change language. Please try again.');
      setSaving(false);
      setOpen(false);
    }
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={saving}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Change language"
        title="Change language"
        className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <Languages className="w-4 h-4" />
        <span className="hidden sm:inline text-xs font-medium">
          {OPTIONS.find((o) => o.value === current)?.label ?? current}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-52 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
        >
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              role="menuitemradio"
              aria-checked={o.value === current}
              onClick={() => void choose(o.value)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-foreground hover:bg-muted"
            >
              {/* Each language is named IN that language — someone who cannot
                  read the current UI language still recognises their own. */}
              <span>{o.label}</span>
              {o.value === current && <Check className="w-4 h-4 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
