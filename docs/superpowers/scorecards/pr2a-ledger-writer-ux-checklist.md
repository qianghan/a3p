# PR 2a — UX consistency review (before merge)

No user-visible change in this PR: it refactors the server-side ledger writer only.

- [x] No screen changed: verified by diff (no files under app/, components/, plugins/*/frontend/).
- [x] No new or changed user-visible strings: verified by diff (no i18n catalog files touched).
- [x] Error responses unchanged: an unbalanced or re-shape-impossible edit still raises ExpenseLedgerShapeError (422), a closed period still raises the same period-closed error, a key collision still carries code P2002.
