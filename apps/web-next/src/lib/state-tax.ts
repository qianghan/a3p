/**
 * US state & Canadian provincial income-tax engine.
 *
 * The implementation now lives in @agentbook/jurisdictions/sub-national-tax so
 * it can be shared by the plugin backends (the chat What-If simulator) as well
 * as these Next.js routes — one canonical source, no divergence. This module is
 * kept as a re-export so existing `@/lib/state-tax` imports keep working.
 */
export type {
  StateBracket,
  StateTaxRule,
  StateTaxResult,
} from '@agentbook/jurisdictions/sub-national-tax';
export {
  STATE_TAX_RULES,
  calculateStateTax,
  isStateModeled,
} from '@agentbook/jurisdictions/sub-national-tax';
