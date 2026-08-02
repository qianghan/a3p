import { describe, it, expect } from 'vitest';
import { triageTurn } from '../consultation-triage';
import { CANONICAL } from '../../../../../tests/e2e/nightly/canonical-utterances';

/**
 * The triage must not divert an utterance away from the skill the canonical
 * eval expects.
 *
 * Consultative turns bypass skill routing entirely, so any eval utterance the
 * classifier claims comes back with skillUsed 'consultation' and fails its
 * assertion. The unit tests cannot see this: they check the classifier against
 * examples I chose, and the eval set is 40 utterances someone else chose.
 *
 * This found three before the eval ran, which would have taken 97.5% to ~90%:
 *
 *   "what deductions can I still claim for last year?"  → tax-deductions
 *   "any alerts for me today?"                          → proactive-alerts
 *   "what subscriptions should I cancel?"               → manage-recurring
 *
 * All three ask about things in the user's own ledger, and the advisor cannot
 * see any of them. The principle that fixed it: a ledger noun outranks
 * interrogative form. "What subscriptions should I cancel?" needs their
 * subscription list; "should I incorporate?" does not.
 *
 * Runs against the real fixture rather than a copy, so adding an eval
 * utterance the triage would swallow fails here rather than at 3am.
 */
describe('triage does not steal utterances the eval routes to a skill', () => {
  // NO general-question exemption.
  //
  // My first version of this guard skipped expectedSkill === 'general-question'
  // on the assumption those were safe to divert. They were not: the runner
  // asserts the literal skill name, and consultation reports 'consultation'.
  // That exemption is exactly why the pre-check found 3 of the 8 failures and
  // the eval found 8 — "what is depreciation?", "should I incorporate?",
  // "do I need to register for GST?" and "what counts as a business meal
  // deduction?" all slipped through it.
  //
  // Those four now carry acceptableSkills: ['consultation'] in the fixture,
  // which is what that field exists for. The rule below is the general one:
  // if triage diverts an utterance, the fixture must accept 'consultation'.
  const accepts = (cu: { expectedSkill?: string; acceptableSkills?: string[] }) =>
    cu.expectedSkill === 'consultation' || (cu.acceptableSkills ?? []).includes('consultation');

  const diverted = CANONICAL.filter(
    (cu) => cu.expectedSkill && !accepts(cu) && triageTurn(cu.text).kind === 'consultative',
  );

  it('every diverted utterance is one the fixture accepts as consultation', () => {
    expect(
      diverted.map((cu) => `${cu.id} "${cu.text}" (expects ${cu.expectedSkill})`),
      'these would return skillUsed=consultation and fail their assertion',
    ).toEqual([]);
  });

  it('the utterances marked acceptable really are the advisory ones', () => {
    // Guards the other direction: acceptableSkills must not become a blanket
    // excuse that hides a genuine misroute.
    const marked = CANONICAL.filter((cu) => (cu.acceptableSkills ?? []).includes('consultation'));
    expect(marked.length).toBeGreaterThan(0);
    for (const cu of marked) {
      expect(
        triageTurn(cu.text).kind,
        `${cu.id} is marked consultation-acceptable but triages transactional`,
      ).toBe('consultative');
    }
  });

  it('the fixture is actually loaded — a guard over an empty list proves nothing', () => {
    // Without this, a broken import path would make the assertion above pass
    // vacuously, which is the failure mode this whole suite keeps finding.
    expect(CANONICAL.length).toBeGreaterThan(30);
    expect(CANONICAL.some((cu) => cu.expectedSkill)).toBe(true);
  });
});
