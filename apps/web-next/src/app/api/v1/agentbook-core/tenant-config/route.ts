/**
 * Tenant config — GET (auto-create on first access) + PUT (upsert).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const VALID_PAYMENT_TERMS = ['net-15', 'net-30', 'net-60', 'due-on-receipt'] as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    let config = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    if (!config) {
      config = await db.abTenantConfig.create({ data: { userId: tenantId } });
    }
    return NextResponse.json({ success: true, data: config });
  } catch (err) {
    console.error('[agentbook-core/tenant-config GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

interface UpdateConfigBody {
  businessType?: string;
  jurisdiction?: string;
  region?: string;
  visaStatus?: string | null;
  homeCountry?: string | null;
  currency?: string;
  locale?: string;
  timezone?: string;
  fiscalYearStart?: number;
  accountingBasis?: string;
  aiCpaAutoFix?: boolean;
  cpaReviewFrequency?: string;
  autoApproveLimitCents?: number;
  autoRemindEnabled?: boolean;
  autoRemindDays?: number[];
  // Invoice defaults
  defaultPaymentTerms?: string | null;
  defaultCurrency?: string | null;
  invoiceFooterNote?: string | null;
  invoiceThankYouMessage?: string | null;
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as UpdateConfigBody;
    const update: Record<string, unknown> = {};
    if (body.businessType) update.businessType = body.businessType;
    if (body.jurisdiction) update.jurisdiction = body.jurisdiction;
    if (body.region !== undefined) update.region = body.region;
    if (body.visaStatus !== undefined) {
      if (body.visaStatus !== null && body.visaStatus !== 'international' && body.visaStatus !== 'domestic') {
        return NextResponse.json({ error: "visaStatus must be 'international', 'domestic', or null" }, { status: 400 });
      }
      update.visaStatus = body.visaStatus;
    }
    if (body.homeCountry !== undefined) update.homeCountry = body.homeCountry;
    if (body.currency) update.currency = body.currency;
    if (body.locale) update.locale = body.locale;
    if (body.timezone) update.timezone = body.timezone;
    if (body.fiscalYearStart) update.fiscalYearStart = body.fiscalYearStart;
    if (body.aiCpaAutoFix !== undefined) update.aiCpaAutoFix = !!body.aiCpaAutoFix;
    if (body.cpaReviewFrequency !== undefined) {
      if (body.cpaReviewFrequency !== 'monthly' && body.cpaReviewFrequency !== 'off') {
        return NextResponse.json({ error: "cpaReviewFrequency must be 'monthly' or 'off'" }, { status: 400 });
      }
      update.cpaReviewFrequency = body.cpaReviewFrequency;
    }
    if (body.accountingBasis !== undefined) {
      if (body.accountingBasis !== 'cash' && body.accountingBasis !== 'accrual') {
        return NextResponse.json({ error: "accountingBasis must be 'cash' or 'accrual'" }, { status: 400 });
      }
      update.accountingBasis = body.accountingBasis;
    }
    if (body.autoApproveLimitCents !== undefined) update.autoApproveLimitCents = body.autoApproveLimitCents;
    if (body.autoRemindEnabled !== undefined) update.autoRemindEnabled = body.autoRemindEnabled;
    if (body.autoRemindDays !== undefined) update.autoRemindDays = body.autoRemindDays;
    // Invoice defaults
    if (body.defaultPaymentTerms !== undefined) {
      if (body.defaultPaymentTerms !== null && !VALID_PAYMENT_TERMS.includes(body.defaultPaymentTerms as typeof VALID_PAYMENT_TERMS[number])) {
        return NextResponse.json({ error: 'invalid defaultPaymentTerms' }, { status: 400 });
      }
      update.defaultPaymentTerms = body.defaultPaymentTerms;
    }
    if (body.defaultCurrency !== undefined) {
      if (body.defaultCurrency !== null && body.defaultCurrency.length !== 3) {
        return NextResponse.json({ error: 'defaultCurrency must be a 3-letter ISO code' }, { status: 400 });
      }
      update.defaultCurrency = body.defaultCurrency;
    }
    if (body.invoiceFooterNote !== undefined) {
      if (body.invoiceFooterNote !== null && body.invoiceFooterNote.length > 500) {
        return NextResponse.json({ error: 'invoiceFooterNote exceeds 500 characters' }, { status: 400 });
      }
      update.invoiceFooterNote = body.invoiceFooterNote;
    }
    if (body.invoiceThankYouMessage !== undefined) {
      if (body.invoiceThankYouMessage !== null && body.invoiceThankYouMessage.length > 200) {
        return NextResponse.json({ error: 'invoiceThankYouMessage exceeds 200 characters' }, { status: 400 });
      }
      update.invoiceThankYouMessage = body.invoiceThankYouMessage;
    }

    const config = await db.abTenantConfig.upsert({
      where: { userId: tenantId },
      update,
      create: {
        userId: tenantId,
        businessType: body.businessType || 'freelancer',
        jurisdiction: body.jurisdiction || 'us',
        region: body.region || '',
        visaStatus: body.visaStatus ?? null,
        homeCountry: body.homeCountry ?? null,
        currency: body.currency || 'USD',
        locale: body.locale || 'en-US',
        timezone: body.timezone || 'America/New_York',
      },
    });
    return NextResponse.json({ success: true, data: config });
  } catch (err) {
    console.error('[agentbook-core/tenant-config PUT] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
