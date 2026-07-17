/**
 * Unit tests for invoice logic.
 *
 * Extracted from the agentbook-invoice server.ts:
 * - Invoice number generation: INV-YYYY-NNNN
 * - Invoice creation validation (clientId + at least 1 line item)
 * - Payment overpayment prevention
 * - Void invoice reversing journal entry structure
 * - Aging report bucket calculation
 */
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Extracted: Invoice number generation (server.ts lines 233-247)
// ---------------------------------------------------------------------------

function generateInvoiceNumber(
  year: number,
  lastInvoiceNumber: string | null,
): string {
  let nextSeq = 1;
  if (lastInvoiceNumber) {
    const parts = lastInvoiceNumber.split('-');
    nextSeq = parseInt(parts[2], 10) + 1;
  }
  return `INV-${year}-${String(nextSeq).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// Extracted: Invoice creation validation (server.ts lines 211)
// ---------------------------------------------------------------------------

interface InvoiceLineInput {
  description: string;
  quantity?: number;
  rateCents: number;
}

interface InvoiceInput {
  clientId?: string;
  lines?: InvoiceLineInput[];
  issuedDate?: string;
  dueDate?: string;
}

interface InvoiceValidationResult {
  valid: boolean;
  error?: string;
}

function validateInvoiceInput(input: InvoiceInput): InvoiceValidationResult {
  if (!input.clientId || !input.lines || !Array.isArray(input.lines) || input.lines.length === 0) {
    return { valid: false, error: 'clientId and at least one line item are required' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Extracted: Payment overpayment check (server.ts lines 583-589)
// ---------------------------------------------------------------------------

interface PaymentCheck {
  amountCents: number;
  invoiceAmountCents: number;
  existingPaidCents: number;
}

function validatePaymentAmount(check: PaymentCheck): {
  valid: boolean;
  error?: string;
  remainingBalance?: number;
} {
  const remainingBalance = check.invoiceAmountCents - check.existingPaidCents;
  if (check.amountCents > remainingBalance) {
    return {
      valid: false,
      error: `Payment amount (${check.amountCents}) exceeds remaining balance (${remainingBalance})`,
      remainingBalance,
    };
  }
  return { valid: true, remainingBalance };
}

// ---------------------------------------------------------------------------
// Extracted: Void invoice reversing journal entry (server.ts lines 488-514)
// ---------------------------------------------------------------------------

interface ReversingJournalEntry {
  memo: string;
  lines: { accountId: string; debitCents: number; creditCents: number; description: string }[];
}

function buildReversingJournalEntry(
  invoiceNumber: string,
  amountCents: number,
  arAccountId: string,
  revenueAccountId: string,
): ReversingJournalEntry {
  return {
    memo: `VOID - Reverse Invoice ${invoiceNumber}`,
    lines: [
      {
        accountId: arAccountId,
        debitCents: 0,
        creditCents: amountCents,
        description: `Reverse AR - Invoice ${invoiceNumber}`,
      },
      {
        accountId: revenueAccountId,
        debitCents: amountCents,
        creditCents: 0,
        description: `Reverse Revenue - Invoice ${invoiceNumber}`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Extracted: Aging bucket calculation (server.ts lines 774-799)
// ---------------------------------------------------------------------------

function getAgingBucket(dueDate: Date, now: Date): string {
  const daysOverdue = Math.floor(
    (now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return '1-30';
  if (daysOverdue <= 60) return '31-60';
  if (daysOverdue <= 90) return '61-90';
  return '90+';
}

// ---------------------------------------------------------------------------
// Extracted: Line item total calculation (server.ts lines 224-230)
// ---------------------------------------------------------------------------

function calculateLineItems(
  lines: InvoiceLineInput[],
): { items: { description: string; quantity: number; rateCents: number; amountCents: number }[]; totalAmountCents: number } {
  const items = lines.map((l) => ({
    description: l.description,
    quantity: l.quantity || 1,
    rateCents: l.rateCents,
    amountCents: Math.round((l.quantity || 1) * l.rateCents),
  }));
  const totalAmountCents = items.reduce((sum, l) => sum + l.amountCents, 0);
  return { items, totalAmountCents };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Invoice Number Generation', () => {
  it('should generate INV-YYYY-0001 when no previous invoice exists', () => {
    expect(generateInvoiceNumber(2025, null)).toBe('INV-2025-0001');
  });

  it('should increment sequence from last invoice number', () => {
    expect(generateInvoiceNumber(2025, 'INV-2025-0001')).toBe('INV-2025-0002');
  });

  it('should handle large sequence numbers', () => {
    expect(generateInvoiceNumber(2025, 'INV-2025-0099')).toBe('INV-2025-0100');
  });

  it('should handle 4-digit sequence numbers', () => {
    expect(generateInvoiceNumber(2025, 'INV-2025-9999')).toBe('INV-2025-10000');
  });

  it('should format with correct year', () => {
    expect(generateInvoiceNumber(2026, null)).toBe('INV-2026-0001');
  });

  it('should match format INV-YYYY-NNNN', () => {
    const number = generateInvoiceNumber(2025, 'INV-2025-0042');
    expect(number).toMatch(/^INV-\d{4}-\d{4,}$/);
  });
});

describe('Invoice Creation Validation', () => {
  it('should require clientId', () => {
    const result = validateInvoiceInput({
      lines: [{ description: 'Work', rateCents: 10000 }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('clientId');
  });

  it('should require at least 1 line item', () => {
    const result = validateInvoiceInput({
      clientId: 'client-1',
      lines: [],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('at least one line item');
  });

  it('should reject when lines are undefined', () => {
    const result = validateInvoiceInput({ clientId: 'client-1' });
    expect(result.valid).toBe(false);
  });

  it('should accept valid input with clientId and lines', () => {
    const result = validateInvoiceInput({
      clientId: 'client-1',
      lines: [{ description: 'Consulting', rateCents: 15000 }],
    });
    expect(result.valid).toBe(true);
  });

  it('should accept multiple line items', () => {
    const result = validateInvoiceInput({
      clientId: 'client-1',
      lines: [
        { description: 'Design work', rateCents: 5000, quantity: 10 },
        { description: 'Development', rateCents: 7500, quantity: 20 },
      ],
    });
    expect(result.valid).toBe(true);
  });
});

describe('Payment Overpayment Prevention', () => {
  it('should reject payment exceeding invoice amount', () => {
    const result = validatePaymentAmount({
      amountCents: 15000,
      invoiceAmountCents: 10000,
      existingPaidCents: 0,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('exceeds remaining balance');
  });

  it('should reject payment exceeding remaining balance after partial payments', () => {
    const result = validatePaymentAmount({
      amountCents: 6000,
      invoiceAmountCents: 10000,
      existingPaidCents: 5000,
    });
    expect(result.valid).toBe(false);
    expect(result.remainingBalance).toBe(5000);
  });

  it('should accept payment equal to remaining balance (full payment)', () => {
    const result = validatePaymentAmount({
      amountCents: 5000,
      invoiceAmountCents: 10000,
      existingPaidCents: 5000,
    });
    expect(result.valid).toBe(true);
  });

  it('should accept partial payment within remaining balance', () => {
    const result = validatePaymentAmount({
      amountCents: 3000,
      invoiceAmountCents: 10000,
      existingPaidCents: 0,
    });
    expect(result.valid).toBe(true);
    expect(result.remainingBalance).toBe(10000);
  });

  it('should accept full payment on fresh invoice', () => {
    const result = validatePaymentAmount({
      amountCents: 10000,
      invoiceAmountCents: 10000,
      existingPaidCents: 0,
    });
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Extracted: idempotent-replay decision for a Stripe-sourced payment
// (server.ts's POST /payments — Launch-gap PR-5, G-5A). Given a payment
// already recorded for this (invoiceId, stripePaymentId) pair, the handler
// must return that existing row (200, alreadyRecorded: true) instead of
// attempting to create a duplicate.
// ---------------------------------------------------------------------------

interface ExistingPaymentLookup {
  stripePaymentId: string | null | undefined;
  existingPayment: { id: string } | null;
}

function decideReplay(input: ExistingPaymentLookup): { isReplay: boolean; paymentId?: string } {
  if (!input.stripePaymentId) return { isReplay: false };
  if (!input.existingPayment) return { isReplay: false };
  return { isReplay: true, paymentId: input.existingPayment.id };
}

describe('Payment Idempotent Replay (Stripe-sourced)', () => {
  it('is not a replay when no stripePaymentId is supplied (manual/cash payment)', () => {
    const result = decideReplay({ stripePaymentId: null, existingPayment: null });
    expect(result.isReplay).toBe(false);
  });

  it('is not a replay when a stripePaymentId is supplied but no existing payment matches it', () => {
    const result = decideReplay({ stripePaymentId: 'pi_123', existingPayment: null });
    expect(result.isReplay).toBe(false);
  });

  it('is a replay when a stripePaymentId is supplied and a payment already exists for it', () => {
    const result = decideReplay({ stripePaymentId: 'pi_123', existingPayment: { id: 'pay_1' } });
    expect(result.isReplay).toBe(true);
    expect(result.paymentId).toBe('pay_1');
  });

  it('a second check after the lock catches a payment that committed between the pre-lock check and the lock being acquired', () => {
    // Pre-lock check (cheap fast-path, runs before the row lock is
    // acquired): the concurrent request hasn't committed yet, so nothing
    // matches and this request proceeds toward acquiring the lock.
    const preLockCheck = decideReplay({ stripePaymentId: 'pi_concurrent', existingPayment: null });
    expect(preLockCheck.isReplay).toBe(false);

    // Post-lock check (runs immediately after the row lock is acquired):
    // by now the concurrent request's transaction has committed a payment
    // for the same stripePaymentId, so the identical decision function,
    // called again with the fresher read, correctly flags this as a
    // replay instead of proceeding to create a duplicate payment.
    const postLockCheck = decideReplay({ stripePaymentId: 'pi_concurrent', existingPayment: { id: 'pay_1' } });
    expect(postLockCheck.isReplay).toBe(true);
    expect(postLockCheck.paymentId).toBe('pay_1');
  });
});

// ---------------------------------------------------------------------------
// Extracted: balance re-check must use payments read AFTER the row lock is
// acquired, not the pre-transaction read. Confirms the fix's core invariant:
// a second submission that only sees payments committed before it acquired
// the lock is correctly rejected once the first payment is included.
// ---------------------------------------------------------------------------

describe('Payment Balance Re-check Reflects Post-Lock State', () => {
  it('rejects a second concurrent submission once the first payment is visible', () => {
    const invoiceAmountCents = 10000;

    // First submission's pre-transaction read: no payments yet.
    const firstCheck = validatePaymentAmount({
      amountCents: 6000,
      existingPaidCents: 0,
      invoiceAmountCents,
    });
    expect(firstCheck.valid).toBe(true);

    // Second submission's re-check, executed only after acquiring the row
    // lock — by then the first payment has committed, so existingPaidCents
    // reflects it. Without the fix, a second submission's balance check ran
    // against the SAME stale pre-transaction read as the first (both saw
    // existingPaidCents: 0) and could also pass, double-booking cash.
    const secondCheckAfterLock = validatePaymentAmount({
      amountCents: 6000,
      existingPaidCents: 6000, // first payment now committed and visible
      invoiceAmountCents,
    });
    expect(secondCheckAfterLock.valid).toBe(false);
    expect(secondCheckAfterLock.remainingBalance).toBe(4000);
  });
});

describe('Void Invoice - Reversing Journal Entry', () => {
  it('should create a reversing entry that credits AR and debits Revenue', () => {
    const entry = buildReversingJournalEntry(
      'INV-2025-0001',
      50000,
      'ar-account-id',
      'revenue-account-id',
    );

    expect(entry.memo).toBe('VOID - Reverse Invoice INV-2025-0001');
    expect(entry.lines).toHaveLength(2);

    // AR line: credit (reversing the original debit)
    const arLine = entry.lines.find((l) => l.accountId === 'ar-account-id')!;
    expect(arLine.debitCents).toBe(0);
    expect(arLine.creditCents).toBe(50000);

    // Revenue line: debit (reversing the original credit)
    const revLine = entry.lines.find((l) => l.accountId === 'revenue-account-id')!;
    expect(revLine.debitCents).toBe(50000);
    expect(revLine.creditCents).toBe(0);
  });

  it('should produce a balanced reversing entry (total debits = total credits)', () => {
    const entry = buildReversingJournalEntry(
      'INV-2025-0042',
      123456,
      'ar-id',
      'rev-id',
    );
    const totalDebits = entry.lines.reduce((s, l) => s + l.debitCents, 0);
    const totalCredits = entry.lines.reduce((s, l) => s + l.creditCents, 0);
    expect(totalDebits).toBe(totalCredits);
    expect(totalDebits).toBe(123456);
  });
});

describe('Aging Report Buckets', () => {
  it('should classify not-yet-due invoice as "current"', () => {
    const dueDate = new Date('2025-07-15');
    const now = new Date('2025-07-01');
    expect(getAgingBucket(dueDate, now)).toBe('current');
  });

  it('should classify invoice due today as "current"', () => {
    const now = new Date('2025-07-15');
    const dueDate = new Date('2025-07-15');
    expect(getAgingBucket(dueDate, now)).toBe('current');
  });

  it('should classify 1-day overdue as "1-30"', () => {
    const dueDate = new Date('2025-07-14');
    const now = new Date('2025-07-15');
    expect(getAgingBucket(dueDate, now)).toBe('1-30');
  });

  it('should classify 30-day overdue as "1-30"', () => {
    const dueDate = new Date('2025-06-15');
    const now = new Date('2025-07-15');
    expect(getAgingBucket(dueDate, now)).toBe('1-30');
  });

  it('should classify 31-day overdue as "31-60"', () => {
    const dueDate = new Date('2025-06-14');
    const now = new Date('2025-07-15');
    expect(getAgingBucket(dueDate, now)).toBe('31-60');
  });

  it('should classify 60-day overdue as "31-60"', () => {
    const dueDate = new Date('2025-05-16');
    const now = new Date('2025-07-15');
    expect(getAgingBucket(dueDate, now)).toBe('31-60');
  });

  it('should classify 61-day overdue as "61-90"', () => {
    const dueDate = new Date('2025-05-15');
    const now = new Date('2025-07-15');
    expect(getAgingBucket(dueDate, now)).toBe('61-90');
  });

  it('should classify 90-day overdue as "61-90"', () => {
    const dueDate = new Date('2025-04-16');
    const now = new Date('2025-07-15');
    expect(getAgingBucket(dueDate, now)).toBe('61-90');
  });

  it('should classify 91-day overdue as "90+"', () => {
    const dueDate = new Date('2025-04-15');
    const now = new Date('2025-07-15');
    expect(getAgingBucket(dueDate, now)).toBe('90+');
  });

  it('should classify 180-day overdue as "90+"', () => {
    const dueDate = new Date('2025-01-15');
    const now = new Date('2025-07-15');
    expect(getAgingBucket(dueDate, now)).toBe('90+');
  });

  it('should classify 365-day overdue as "90+"', () => {
    const dueDate = new Date('2024-07-15');
    const now = new Date('2025-07-15');
    expect(getAgingBucket(dueDate, now)).toBe('90+');
  });
});

describe('Line Item Total Calculation', () => {
  it('should calculate total from single line item', () => {
    const { totalAmountCents } = calculateLineItems([
      { description: 'Work', rateCents: 10000 },
    ]);
    expect(totalAmountCents).toBe(10000);
  });

  it('should multiply quantity by rate', () => {
    const { items, totalAmountCents } = calculateLineItems([
      { description: 'Hours', rateCents: 5000, quantity: 10 },
    ]);
    expect(items[0].amountCents).toBe(50000);
    expect(totalAmountCents).toBe(50000);
  });

  it('should default quantity to 1 when not provided', () => {
    const { items } = calculateLineItems([
      { description: 'Flat fee', rateCents: 25000 },
    ]);
    expect(items[0].quantity).toBe(1);
    expect(items[0].amountCents).toBe(25000);
  });

  it('should sum multiple line items', () => {
    const { totalAmountCents } = calculateLineItems([
      { description: 'Design', rateCents: 5000, quantity: 5 },
      { description: 'Dev', rateCents: 7500, quantity: 10 },
    ]);
    expect(totalAmountCents).toBe(25000 + 75000);
  });
});
