/**
 * Tax E-Filing — partner API submission, status polling, mock provider.
 */
import { db } from './db/client.js';
import { validateFiling } from './tax-export.js';

// === Mock E-Filing Provider (for development) ===
// In production, this would call Wealthsimple Tax API or a NETFILE-certified vendor.

async function mockSubmit(filingData: any): Promise<{ confirmationNumber: string; status: string }> {
  // Simulate API latency
  await new Promise(r => setTimeout(r, 500));
  // AgentBook reference for the exported package — NOT a CRA confirmation number.
  // AgentBook does not lodge returns with the CRA; the user files it themselves.
  const confNum = `AB-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  return { confirmationNumber: confNum, status: 'accepted' };
}

async function mockCheckStatus(confirmationNumber: string): Promise<{ status: string; details?: string }> {
  // Simulate status check
  return { status: 'accepted', details: 'Package prepared and exported. AgentBook does not lodge with the CRA — file it yourself; the CRA issues your Notice of Assessment after you file.' };
}

/**
 * Decide how a submission is recorded and described. Pure — the single source
 * of truth for the honesty rule: ONLY a certified-partner acceptance counts as
 * 'filed'; the mock / no-partner path is an export the user still has to lodge,
 * and must never be reported as filed.
 */
export function buildFilingOutcome(
  viaCertifiedPartner: boolean,
  result: { confirmationNumber: string; status: string },
): { dbStatus: string; filedStatus: string; status: string; filed: boolean; filedAtDate: Date | null; message: string } {
  if (viaCertifiedPartner) {
    return {
      dbStatus: 'filed',
      filedStatus: result.status,
      status: result.status,
      filed: true,
      filedAtDate: new Date(),
      message: `Your return was filed with the tax authority via a certified e-file partner (confirmation ${result.confirmationNumber}, status ${result.status}).`,
    };
  }
  return {
    dbStatus: 'exported',
    filedStatus: 'exported_not_filed',
    status: 'exported',
    filed: false,
    filedAtDate: null,
    message: `Your return package is finalized and exported (ref ${result.confirmationNumber}). This is NOT a filing — AgentBook does not lodge with the tax authority. File it yourself via NETFILE / your tax authority account.`,
  };
}

// === Submit Filing ===

export async function submitFiling(
  tenantId: string, taxYear: number,
): Promise<{ success: boolean; data?: any; error?: string }> {
  // 1. Load filing
  const filing = await db.abTaxFiling.findFirst({
    where: { tenantId, taxYear, filingType: 'personal_return' },
  });
  if (!filing) return { success: false, error: 'No filing found for this year' };

  // 2. Check status — must be 'complete' or 'exported'
  if (!['complete', 'exported', 'in_progress'].includes(filing.status)) {
    if (filing.status === 'filed') {
      return { success: false, error: `Already filed on ${filing.filedAt?.toLocaleDateString()}. Confirmation: ${filing.filedRef}` };
    }
    return { success: false, error: `Filing status is "${filing.status}" — must be complete or exported before filing` };
  }

  // 3. Validate
  const forms = (filing.forms as Record<string, any>) || {};
  const validation = validateFiling(forms);
  if (!validation.valid) {
    return {
      success: false,
      error: `Cannot file — ${validation.errors.length} validation error(s)`,
      data: { validation },
    };
  }

  // 4. Load partner config (or use mock)
  // safe: AbTaxFilingPartner is a platform registry of e-filing intermediaries; no tenantId field by schema design.
  const partner = await db.abTaxFilingPartner.findFirst({
    where: { jurisdiction: filing.jurisdiction, enabled: true },
  });

  // Only a real, certified partner submission may mark a return as actually
  // 'filed' with the tax authority. The mock/no-partner path produces an
  // EXPORTED package the user lodges themselves — it must never claim 'filed'.
  const viaCertifiedPartner = !!partner?.apiUrl;

  let result: { confirmationNumber: string; status: string };
  if (partner?.apiUrl) {
    // Real partner API call
    try {
      const res = await fetch(partner.apiUrl + '/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${partner.apiKey}`,
          'X-Cert-ID': partner.certId || '',
        },
        body: JSON.stringify({
          taxYear,
          jurisdiction: filing.jurisdiction,
          region: filing.region,
          forms,
        }),
      });
      result = await res.json() as any;
    } catch (err) {
      return { success: false, error: `Partner API error: ${err}` };
    }
  } else {
    // Use mock provider for development
    result = await mockSubmit({ taxYear, forms });
  }

  // 5. Update filing. A certified-partner acceptance is a real filing; the mock
  // path is an EXPORT the user still has to lodge — record it as 'exported' so
  // the system (and its "already filed" guard) never believes it was filed.
  const outcome = buildFilingOutcome(viaCertifiedPartner, result);
  await db.abTaxFiling.update({
    where: { id: filing.id },
    data: {
      status: outcome.dbStatus,
      filedAt: outcome.filedAtDate,
      filedRef: result.confirmationNumber,
      filedStatus: outcome.filedStatus,
    },
  });

  return {
    success: true,
    data: {
      confirmationNumber: result.confirmationNumber,
      status: outcome.status,
      filed: outcome.filed,
      filedAt: outcome.filedAtDate ? outcome.filedAtDate.toISOString() : null,
      message: outcome.message,
    },
  };
}

// === Check Filing Status ===

export async function checkFilingStatus(
  tenantId: string, taxYear: number,
): Promise<{ success: boolean; data?: any; error?: string }> {
  const filing = await db.abTaxFiling.findFirst({
    where: { tenantId, taxYear, filingType: 'personal_return' },
  });
  if (!filing) return { success: false, error: 'No filing found' };

  if (filing.status !== 'filed' || !filing.filedRef) {
    return {
      success: true,
      data: {
        status: filing.status,
        message: filing.status === 'filed'
          ? `Filed. Confirmation: ${filing.filedRef}`
          : `Filing status: ${filing.status}. Not yet submitted.`,
      },
    };
  }

  // Poll partner for status update
  // safe: AbTaxFilingPartner is a platform registry of e-filing intermediaries; no tenantId field by schema design.
  const partner = await db.abTaxFilingPartner.findFirst({
    where: { jurisdiction: filing.jurisdiction, enabled: true },
  });

  let statusResult: { status: string; details?: string };
  if (partner?.apiUrl) {
    try {
      const res = await fetch(`${partner.apiUrl}/status/${filing.filedRef}`, {
        headers: { 'Authorization': `Bearer ${partner.apiKey}` },
      });
      statusResult = await res.json() as any;
    } catch {
      statusResult = { status: filing.filedStatus || 'unknown', details: 'Could not reach partner API' };
    }
  } else {
    statusResult = await mockCheckStatus(filing.filedRef);
  }

  // Update filing status if changed
  if (statusResult.status !== filing.filedStatus) {
    await db.abTaxFiling.update({
      where: { id: filing.id },
      data: { filedStatus: statusResult.status },
    });
  }

  return {
    success: true,
    data: {
      confirmationNumber: filing.filedRef,
      filedAt: filing.filedAt?.toISOString(),
      status: statusResult.status,
      details: statusResult.details,
      message: `Filing status: **${statusResult.status}**\nConfirmation: ${filing.filedRef}\nFiled: ${filing.filedAt?.toLocaleDateString()}${statusResult.details ? '\n' + statusResult.details : ''}`,
    },
  };
}

// === Seed Mock Partner (for development) ===

export async function seedMockPartner(): Promise<void> {
  await db.abTaxFilingPartner.upsert({
    where: { jurisdiction_partnerName: { jurisdiction: 'ca', partnerName: 'mock' } },
    update: {},
    create: {
      jurisdiction: 'ca',
      partnerName: 'mock',
      apiUrl: '', // empty = use mock provider
      enabled: true,
    },
  });
}
