/** Parse the model's receipt-OCR JSON (tolerant of ```json fences) into cents. */
export function parseReceiptJson(text: string): { amountCents: number | null; vendor: string | null; date: string | null } {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return { amountCents: null, vendor: null, date: null };
  }
  const total = typeof obj.total === 'number'
    ? obj.total
    : (typeof obj.amount === 'number' ? obj.amount : null);
  const amountCents = total != null ? Math.round(total * 100) : null;
  const vendor = typeof obj.vendor === 'string' && obj.vendor.trim() ? obj.vendor.trim() : null;
  const date = typeof obj.date === 'string' && obj.date.trim() ? obj.date.trim() : null;
  return { amountCents, vendor, date };
}
