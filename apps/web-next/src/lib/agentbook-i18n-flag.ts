import 'server-only';
import { prisma } from '@naap/database';

/**
 * Gate for user-visible LOCALE TRANSLATION (decision D2).
 *
 * WHAT THIS GATES, AND WHAT IT DELIBERATELY DOES NOT
 *
 *   gated      translated STRINGS. With the flag off, every user reads
 *              English regardless of the locale stored on their tenant.
 *
 *   NOT gated  locale-aware FORMATTING — dates, money, numbers. Those
 *              changes are strict correctness fixes (a bill due date was
 *              rendering a day early west of UTC), they are already live,
 *              and holding them behind a flag would keep a real bug in
 *              production for no benefit.
 *
 * WHY GATING THE PICKER WOULD NOT BE ENOUGH
 * A CA tenant may ALREADY hold `locale = 'fr-CA'`, written by the old
 * Canada-only language selector that predates this work. Hiding the picker
 * would leave those tenants reading partially-translated French the moment
 * the first strings land. The gate therefore applies at RESOLUTION, not at
 * selection: flag off means the translator is built for English no matter
 * what is stored.
 *
 * Fail-closed by design (`?? false`). A missing row, or a database error at
 * the call site, must mean "English", never "ship half-translated UI" — this
 * repo has already had to fix fail-OPEN gates once.
 */
export const I18N_LOCALES_FLAG_KEY = 'agentbook.i18n.locales.enabled';

export async function isI18nLocalesEnabled(): Promise<boolean> {
  try {
    const row = await prisma.featureFlag.findUnique({
      where: { key: I18N_LOCALES_FLAG_KEY },
    });
    return row?.enabled ?? false;
  } catch {
    // Fail closed: a flag lookup failure must not expose partial translation.
    return false;
  }
}
