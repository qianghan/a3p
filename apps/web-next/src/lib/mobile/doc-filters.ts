import type { DocFilter } from './types';

/**
 * The ONE mapping from a Docs filter chip to /api/v1/agentbook-expense/expenses
 * query params. The server builds DocCounts and the home-screen
 * `uncategorized` / `review_needed` alert counts from this table, and the
 * client builds listDocs() params from it, so a chip's badge, its list and
 * the alert that links to it cannot disagree.
 */
export const DOC_FILTER_PARAMS: Readonly<Record<DocFilter, Readonly<Record<string, string>>>> = {
  'needs-review': { status: 'pending_review' },
  'no-category': { categoryId: 'none', isPersonal: 'false' },
  'no-receipt': { hasReceipt: 'false', isPersonal: 'false' },
  all: {},
  archived: { archived: 'true' },
};
