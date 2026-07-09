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

const VALID_BUSINESS_TYPES = ['freelancer', 'sole_proprietor', 'consultant', 'contractor', 'agency', 'startup', 'student'] as const;

interface UpdateConfigBody {
  businessType?: string;
  jurisdiction?: string;
  region?: string;
  visaStatus?: string | null;
  homeCountry?: string | null;
  // Student businessType only
  university?: string | null;
  major?: string | null;
  degree?: string | null;
  graduationYear?: number | null;
  // Non-student businessType only — classification, also drives plugin-visibility gating
  businessDescription?: string | null;
  businessTags?: string[];
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
  // Business identity — rendered/edited in the Profile tab but previously
  // missing from this whitelist, so saving them silently no-op'd.
  companyName?: string | null;
  companyEmail?: string | null;
  companyPhone?: string | null;
  companyAddress?: string | null;
  brandColor?: string;
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as UpdateConfigBody;
    const existing = await db.abTenantConfig.findUnique({
      where: { userId: tenantId },
      select: { businessType: true, university: true, major: true, degree: true, graduationYear: true },
    });
    const update: Record<string, unknown> = {};
    if (body.businessType) {
      if (!VALID_BUSINESS_TYPES.includes(body.businessType as typeof VALID_BUSINESS_TYPES[number])) {
        return NextResponse.json({ error: `businessType must be one of: ${VALID_BUSINESS_TYPES.join(', ')}` }, { status: 400 });
      }
      update.businessType = body.businessType;
    }
    if (body.jurisdiction) update.jurisdiction = body.jurisdiction;
    if (body.region !== undefined) update.region = body.region;
    if (body.visaStatus !== undefined) {
      if (body.visaStatus !== null && body.visaStatus !== 'international' && body.visaStatus !== 'domestic') {
        return NextResponse.json({ error: "visaStatus must be 'international', 'domestic', or null" }, { status: 400 });
      }
      update.visaStatus = body.visaStatus;
    }
    if (body.homeCountry !== undefined) update.homeCountry = body.homeCountry;
    if (body.university !== undefined) update.university = body.university;
    if (body.major !== undefined) update.major = body.major;
    if (body.degree !== undefined) update.degree = body.degree;
    if (body.graduationYear !== undefined) update.graduationYear = body.graduationYear;
    if (body.businessDescription !== undefined) update.businessDescription = body.businessDescription;
    if (body.businessTags !== undefined) update.businessTags = body.businessTags;
    if (body.companyName !== undefined) update.companyName = body.companyName;
    if (body.companyEmail !== undefined) update.companyEmail = body.companyEmail;
    if (body.companyPhone !== undefined) update.companyPhone = body.companyPhone;
    if (body.companyAddress !== undefined) update.companyAddress = body.companyAddress;
    if (body.brandColor) update.brandColor = body.brandColor;
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

    // Student businessType requires university/major/degree/graduationYear —
    // scholarship and co-op/internship search skills key off these (timing
    // in particular depends on graduationYear), so an incomplete profile
    // silently degrades that advice. Checked against the resulting state
    // (this update merged onto whatever already exists), not just the
    // fields in this body, so switching to student and filling them in
    // later still gets caught.
    const effectiveBusinessType = body.businessType ?? existing?.businessType;
    if (effectiveBusinessType === 'student') {
      const effectiveUniversity = body.university !== undefined ? body.university : existing?.university;
      const effectiveMajor = body.major !== undefined ? body.major : existing?.major;
      const effectiveDegree = body.degree !== undefined ? body.degree : existing?.degree;
      const effectiveGraduationYear = body.graduationYear !== undefined ? body.graduationYear : existing?.graduationYear;
      const missing = [
        !effectiveUniversity && 'university',
        !effectiveMajor && 'major',
        !effectiveDegree && 'degree',
        !effectiveGraduationYear && 'graduationYear',
      ].filter((f): f is string => !!f);
      if (missing.length > 0) {
        return NextResponse.json(
          { error: `Student business type requires: ${missing.join(', ')}` },
          { status: 400 },
        );
      }
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
