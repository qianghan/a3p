/**
 * Invoice list + create — native Next.js route.
 *
 * GET: list with status/date/client filters.
 * POST: create with line items, AR/Revenue journal entry, client total
 * update, and audit event in a single transaction.
 *
 * Detail (`/:id`), state transitions (`send`, `void`, `remind`, payments,
 * recurring) still 501 via the generic proxy until each is ported.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { audit } from '@/lib/agentbook-audit';
import { inferSource, inferActor } from '@/lib/agentbook-audit-context';
import { withSoftDelete, parseIncludeDeleted } from '@/lib/agentbook-soft-delete';
import { withHttpIdempotency } from '@/lib/agentbook-idempotency';
import { computeInvoiceTax } from '@/lib/agentbook-invoice-tax';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const params = request.nextUrl.searchParams;
    const status = params.get('status');
    const clientId = params.get('clientId');
    const startDate = params.get('startDate');
    const endDate = params.get('endDate');
    const limit = parseInt(params.get('limit') || '50', 10);
    const offset = parseInt(params.get('offset') || '0', 10);

    const includeDeleted = parseIncludeDeleted(params);
    const baseWhere: Record<string, unknown> = { tenantId };
    if (status) baseWhere.status = status;
    if (clientId) baseWhere.clientId = clientId;
    if (startDate || endDate) {
      const issuedDate: Record<string, Date> = {};
      if (startDate) issuedDate.gte = new Date(startDate);
      if (endDate) issuedDate.lte = new Date(endDate);
      baseWhere.issuedDate = issuedDate;
    }
    const where = withSoftDelete(baseWhere, includeDeleted);

    const [invoices, total] = await Promise.all([
      db.abInvoice.findMany({
        where,
        include: { lines: true, client: true },
        orderBy: { issuedDate: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.abInvoice.count({ where }),
    ]);

    return NextResponse.json({
      success: true,
      data: invoices,
      pagination: { total, limit, offset },
    });
  } catch (err) {
    console.error('[agentbook-invoice/invoices GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

interface InvoiceLine {
  description?: string;
  quantity?: number;
  rateCents: number;
}

interface CreateInvoiceBody {
  clientId?: string;
  issuedDate?: string;
  dueDate?: string;
  lines?: InvoiceLine[];
  status?: string;
  currency?: string;
  /** When set (2-60), recognize this invoice's revenue evenly over N months. */
  deferOverMonths?: number;
  /**
   * Explicit tax rate override (a fraction, e.g. 0.10), from an editable
   * frontend field. When omitted, the tenant's jurisdiction default
   * applies (AU flat GST, CA province GST/HST/PST) — see computeInvoiceTax.
   */
  taxRate?: number;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const auditSource = inferSource(request);
  const auditActor = await inferActor(request);

  return withHttpIdempotency(request, {
    tenantId,
    endpoint: 'POST /api/v1/agentbook-invoice/invoices',
    handler: async (rawBody) => {
      try {
        let body: CreateInvoiceBody = {};
        try {
          body = rawBody ? (JSON.parse(rawBody) as CreateInvoiceBody) : {};
        } catch {
          body = {};
        }
        const { clientId, issuedDate, dueDate, lines, status, currency, deferOverMonths, taxRate: taxRateOverride } = body;
        // Clamp deferral months to a sane range; ignore anything outside it.
        const deferMonths =
          typeof deferOverMonths === 'number' && deferOverMonths >= 2 && deferOverMonths <= 60
            ? Math.floor(deferOverMonths)
            : null;

        if (!clientId || !lines || !Array.isArray(lines) || lines.length === 0) {
          return {
            status: 400,
            body: { success: false, error: 'clientId and at least one line item are required' },
          };
        }

        const client = await db.abClient.findFirst({ where: { id: clientId, tenantId } });
        if (!client) {
          return { status: 404, body: { success: false, error: 'Client not found' } };
        }

        const lineItems = lines.map((l) => ({
          tenantId, // G-009
          description: l.description || '',
          quantity: l.quantity || 1,
          rateCents: l.rateCents,
          amountCents: Math.round((l.quantity || 1) * l.rateCents),
        }));
        const totalAmountCents = lineItems.reduce((sum, l) => sum + l.amountCents, 0);
        const subtotalCents = totalAmountCents;
        const taxResult = await computeInvoiceTax(tenantId, subtotalCents, taxRateOverride ?? null);
        const grandTotalCents = subtotalCents + taxResult.taxCents;

        const year = new Date(issuedDate || Date.now()).getFullYear();
        const lastInvoice = await db.abInvoice.findFirst({
          where: { tenantId, number: { startsWith: `INV-${year}-` } },
          orderBy: { number: 'desc' },
        });

        let nextSeq = 1;
        if (lastInvoice) {
          const parts = lastInvoice.number.split('-');
          nextSeq = parseInt(parts[2], 10) + 1;
        }
        const invoiceNumber = `INV-${year}-${String(nextSeq).padStart(4, '0')}`;

        const requiredLiabilityCodes = [...new Set(taxResult.components.map((c) => c.accountCode))];
        const [arAccount, revenueAccount, liabilityAccounts] = await Promise.all([
          db.abAccount.findUnique({ where: { tenantId_code: { tenantId, code: '1100' } } }),
          db.abAccount.findUnique({ where: { tenantId_code: { tenantId, code: '4000' } } }),
          requiredLiabilityCodes.length > 0
            ? db.abAccount.findMany({ where: { tenantId, code: { in: requiredLiabilityCodes } } })
            : Promise.resolve([]),
        ]);

        if (!arAccount || !revenueAccount) {
          return {
            status: 422,
            body: {
              success: false,
              error: 'AR account (1100) or Revenue account (4000) not found. Ensure chart of accounts is seeded.',
            },
          };
        }
        const liabilityAccountsByCode = new Map(liabilityAccounts.map((a) => [a.code, a]));
        const missingLiabilityCode = requiredLiabilityCodes.find((code) => !liabilityAccountsByCode.has(code));
        if (missingLiabilityCode) {
          return {
            status: 422,
            body: {
              success: false,
              error: `Tax liability account (${missingLiabilityCode}) not found. Ensure chart of accounts is seeded.`,
            },
          };
        }

        try {
          const invoice = await db.$transaction(async (tx) => {
            const journalLines = [
              { tenantId, accountId: arAccount.id, debitCents: grandTotalCents, creditCents: 0, description: `AR - Invoice ${invoiceNumber}` }, // G-009
              { tenantId, accountId: revenueAccount.id, debitCents: 0, creditCents: subtotalCents, description: `Revenue - Invoice ${invoiceNumber}` }, // G-009
              ...taxResult.components.map((c) => ({
                tenantId, // G-009
                accountId: liabilityAccountsByCode.get(c.accountCode)!.id,
                debitCents: 0,
                creditCents: c.amountCents,
                description: `${c.type} Payable - Invoice ${invoiceNumber}`,
              })),
            ];

            const journalEntry = await tx.abJournalEntry.create({
              data: {
                tenantId,
                date: new Date(issuedDate || Date.now()),
                memo: `Invoice ${invoiceNumber} to ${client.name}`,
                sourceType: 'invoice',
                verified: true,
                lines: { create: journalLines },
              },
            });

            const inv = await tx.abInvoice.create({
              data: {
                tenantId,
                clientId,
                number: invoiceNumber,
                amountCents: grandTotalCents,
                taxRate: taxResult.taxRate || null,
                taxCents: taxResult.taxCents,
                currency: currency || 'USD',
                issuedDate: new Date(issuedDate || Date.now()),
                dueDate: new Date(dueDate || Date.now()),
                status: status || 'draft',
                journalEntryId: journalEntry.id,
                lines: { create: lineItems },
              },
              include: { lines: true },
            });

            if (taxResult.components.length > 0) {
              const taxTenantConfig = await tx.abTenantConfig.findUnique({
                where: { userId: tenantId },
                select: { jurisdiction: true, region: true },
              });
              await tx.abSalesTaxCollected.createMany({
                data: taxResult.components.map((c) => ({
                  tenantId,
                  invoiceId: inv.id,
                  jurisdiction: taxTenantConfig?.jurisdiction || 'us',
                  region: taxTenantConfig?.region || '',
                  taxType: c.type,
                  rate: c.rate,
                  amountCents: c.amountCents,
                })),
              });
            }

            await tx.abJournalEntry.update({ where: { id: journalEntry.id }, data: { sourceId: inv.id } });
            await tx.abClient.update({
              where: { id: clientId },
              data: { totalBilledCents: { increment: grandTotalCents } },
            });

            // Optional deferred-revenue schedule (retainers/subscriptions).
            if (deferMonths) {
              const start = new Date(issuedDate || Date.now());
              const end = new Date(start);
              end.setMonth(end.getMonth() + deferMonths);
              await tx.abDeferredRevenue.create({
                data: {
                  tenantId,
                  invoiceId: inv.id,
                  totalAmountCents: subtotalCents,
                  recognizedAmountCents: 0,
                  startDate: start,
                  endDate: end,
                  periodMonths: deferMonths,
                },
              });
            }

            await tx.abEvent.create({
              data: {
                tenantId,
                eventType: 'invoice.created',
                actor: 'agent',
                action: {
                  invoiceId: inv.id,
                  number: invoiceNumber,
                  clientId,
                  amountCents: grandTotalCents,
                  subtotalCents,
                  taxCents: taxResult.taxCents,
                  lineCount: lineItems.length,
                },
                constraintsPassed: ['balance_invariant'],
                verificationResult: 'passed',
              },
            });

            return inv;
          });
          // PR 10 — structured audit row alongside the loose AbEvent.
          await audit({
            tenantId,
            source: auditSource,
            actor: auditActor,
            action: 'invoice.create',
            entityType: 'AbInvoice',
            entityId: invoice.id,
            after: {
              number: invoice.number,
              clientId,
              amountCents: grandTotalCents,
              currency: invoice.currency,
              status: invoice.status,
              issuedDate: invoice.issuedDate,
              dueDate: invoice.dueDate,
              lineCount: lineItems.length,
            },
          });
          return { status: 201, body: { success: true, data: invoice } };
        } catch (err: unknown) {
          if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
            return { status: 409, body: { success: false, error: 'Invoice number already exists' } };
          }
          throw err;
        }
      } catch (err) {
        console.error('[agentbook-invoice/invoices POST] failed:', err);
        return {
          status: 500,
          body: { success: false, error: err instanceof Error ? err.message : String(err) },
        };
      }
    },
  });
}
