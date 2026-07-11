import { db } from './db/client.js';

function computeAge(dateOfBirth: Date): number {
  const now = new Date();
  let age = now.getFullYear() - dateOfBirth.getFullYear();
  const hasHadBirthdayThisYear =
    now.getMonth() > dateOfBirth.getMonth() ||
    (now.getMonth() === dateOfBirth.getMonth() && now.getDate() >= dateOfBirth.getDate());
  if (!hasHadBirthdayThisYear) age -= 1;
  return age;
}

const MARITAL_STATUS_LABELS: Record<string, string> = {
  single: 'Single',
  married_joint: 'Married, filing jointly',
  married_separate: 'Married, filing separately',
  head_of_household: 'Head of household',
  widowed: 'Widowed',
};

const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  w2: 'Employed (W-2)',
  self_employed: 'Self-employed',
  mixed: 'Both employed & self-employed',
  unemployed: 'Not currently working',
  retired: 'Retired',
};

function fmt(cents?: number | null): string {
  if (cents == null) return 'n/a';
  return '$' + Math.round(cents / 100).toLocaleString();
}

/** Same completeness bar as the personal-profile API route — keep in sync. */
function isComplete(profile: {
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: Date | null;
  city: string | null;
  state: string | null;
  country: string | null;
  maritalStatus: string | null;
  employmentType: string | null;
}): boolean {
  return Boolean(
    profile.firstName &&
      profile.lastName &&
      profile.dateOfBirth &&
      profile.city &&
      profile.state &&
      profile.country &&
      profile.maritalStatus &&
      profile.employmentType,
  );
}

/**
 * Build an LLM-ready personal-context summary from the user's profile.
 * Returns '' when there's no profile, or it isn't complete enough to be
 * useful (additive: callers append only when non-empty, so behavior is
 * unchanged for users who haven't filled this in). Pure DB read — no HTTP
 * self-call. Mirrors buildPastFilingContext()'s shape/conventions.
 */
export async function buildPersonalProfileContext(userId: string): Promise<string> {
  const profile = await db.abPersonalProfile.findUnique({ where: { userId } });
  if (!profile || !isComplete(profile)) return '';

  const lines: string[] = ['## User profile (reference only — do not repeat raw personal details back unless asked)', ''];
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
  if (name) lines.push(`Name: ${name}`);
  if (profile.dateOfBirth) lines.push(`Age: ${computeAge(profile.dateOfBirth)}`);
  if (profile.state || profile.country) {
    lines.push(`Location: ${[profile.city, profile.state, profile.country].filter(Boolean).join(', ')}`);
  }
  if (profile.maritalStatus) lines.push(`Marital status: ${MARITAL_STATUS_LABELS[profile.maritalStatus] || profile.maritalStatus}`);
  if (profile.dependentsCount != null) lines.push(`Dependents: ${profile.dependentsCount}`);
  if (profile.employmentType) lines.push(`Employment: ${EMPLOYMENT_TYPE_LABELS[profile.employmentType] || profile.employmentType}`);
  if (profile.occupation) lines.push(`Occupation: ${profile.occupation}`);
  if (profile.estimatedAnnualIncomeCents != null) lines.push(`Estimated annual income: ${fmt(profile.estimatedAnnualIncomeCents)}`);

  return lines.join('\n');
}
