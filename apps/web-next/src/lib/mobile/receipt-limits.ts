/**
 * Receipt-upload limits shared by POST /expenses/from-receipt (server) and the
 * /app client's uploadReceipt (pre-flight). Pure — no server-only, no Prisma —
 * so the client refuses exactly what the server would, before spending an
 * upload on it.
 */

/** Just under Vercel's 4.5 MB request-body limit; larger photos are compressed client-side. */
export const RECEIPT_MAX_BYTES = 4_400_000;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
/** AbExpense amount columns are 32-bit Int; anything above this is not a real receipt. */
export const MAX_AMOUNT_CENTS = 2_000_000_000;
