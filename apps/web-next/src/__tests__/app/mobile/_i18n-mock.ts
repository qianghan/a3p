/**
 * Real English translator for component tests. useT() outside the shell
 * provider humanises the key's last segment, so a test asserting on
 * "Needs review" would pass against a MISSING key. Mocking '@/hooks/use-t'
 * with the real catalog makes every rendered string prove its key exists.
 *
 * Usage (vi.mock is hoisted, so the factory must import lazily):
 *   vi.mock('@/hooks/use-t', async () => (await import('./_i18n-mock')).useTMock);
 */
import { createTranslator } from '@agentbook/i18n';
import { CATALOG } from '@agentbook/i18n/catalog';

const tr = createTranslator('en', CATALOG);
export const enT = tr.t;
export const useTMock = { useT: () => tr.t, useShellLocale: () => 'en' };
