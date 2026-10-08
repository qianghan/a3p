/** Display helpers shared by Docs and Capture. Money itself goes through the kit's <Money>. */

function toDate(iso: string): Date {
  // A bare YYYY-MM-DD is a calendar date, not an instant — pin it to UTC and
  // format in UTC, or a user west of Greenwich sees the previous day.
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
}

export function formatDocDate(iso: string, locale: string): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function formatTime(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

export function isPdfUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return /\.pdf$/i.test(new URL(url, 'https://placeholder.invalid').pathname);
  } catch {
    return /\.pdf(\?|#|$)/i.test(url);
  }
}

/** The value an amount <input> starts with: locale decimal separator, never grouping (so it re-parses). */
export function formatAmountInput(cents: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(cents / 100);
  } catch {
    return (cents / 100).toFixed(2);
  }
}

export function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
