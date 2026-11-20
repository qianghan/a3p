/**
 * PR 4e — chat (core) and web share one frequency-label map. Core cannot import
 * apps/web-next/src/lib, so agentFrequencyLabelKey mirrors frequencyLabelKey(…, 'agent');
 * this pins them together for every frequency × market.
 */
import { describe, it, expect } from 'vitest';
import { agentFrequencyLabelKey } from '@agentbook-core/employee-chat';
import { frequencyLabelKey, PAY_FREQUENCIES } from '@/lib/payroll-frequency';

describe('chat frequency labels == web frequency labels', () => {
  for (const f of [...PAY_FREQUENCIES, 'bogus'])
    for (const j of ['us', 'ca', 'au', 'uk'])
      it(`${f}/${j}`, () => expect(agentFrequencyLabelKey(f, j)).toBe(frequencyLabelKey(f, j, 'agent')));
});
