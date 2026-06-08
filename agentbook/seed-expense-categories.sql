-- Seed expense-category Account rows for each persona and link the
-- previously-seeded AbExpense rows to them.
--
-- Background: the category-summary endpoint joins AbExpense.categoryId
-- against AbAccount.id to resolve the display name. Without these rows
-- every expense rolls up to "Uncategorized" — which the UI shows as the
-- red ❓ emoji on the category cards.
--
-- The category names match the keys in CATEGORY_ICONS
-- (plugins/agentbook-expense/frontend/src/pages/ExpenseList.tsx) so each
-- card gets a proper emoji. Codes follow the chart-of-accounts 5xxx
-- expense convention.
--
-- Idempotent: ON CONFLICT (tenantId, code) DO NOTHING for the accounts.

BEGIN;

-- ===========================================================================
-- Account stubs per persona (one INSERT per tenant × category)
-- ===========================================================================

WITH cats(code, name, taxCategory) AS (
  VALUES
    ('5010', 'Meals',                    'meals'),
    ('5020', 'Travel',                   'travel'),
    ('5030', 'Software & Subscriptions', 'software'),
    ('5040', 'Office Expenses',          'office-supplies'),
    ('5050', 'Legal & Professional',     'professional'),
    ('5060', 'Rent',                     'rent'),
    ('5070', 'Advertising',              'advertising'),
    ('5080', 'Insurance',                'insurance'),
    ('5090', 'Utilities',                'utilities'),
    ('5100', 'Supplies',                 'supplies'),
    ('5110', 'Contract Labor',           'contractor'),
    ('5120', 'Commissions & Fees',       'fees'),
    ('5130', 'Car & Truck',              'auto'),
    ('5140', 'Bank Fees',                'bank-fees'),
    ('5150', 'Shipping',                 'shipping'),
    ('5160', 'Cost of Goods Sold',       'cogs')
), tenants(tenantId) AS (
  VALUES
    ('usr_maya_seed_001'),
    ('usr_alex_seed_002'),
    ('usr_jordan_seed_003')
)
INSERT INTO plugin_agentbook_core."AbAccount"
  (id, "tenantId", code, name, "accountType", "taxCategory", "isActive", "createdAt", "updatedAt")
SELECT
  'acc_' || t.tenantId || '_' || c.code,
  t.tenantId,
  c.code,
  c.name,
  'expense',
  c.taxCategory,
  true,
  now(),
  now()
FROM tenants t CROSS JOIN cats c
ON CONFLICT ("tenantId", code) DO NOTHING;

-- ===========================================================================
-- Re-point the seeded AbExpense rows to the new Account IDs
-- ===========================================================================

UPDATE plugin_agentbook_expense."AbExpense" e
SET "categoryId" = a.id
FROM plugin_agentbook_core."AbAccount" a
WHERE a."tenantId" = e."tenantId"
  AND a."accountType" = 'expense'
  AND (
    (e."categoryId" = 'meals'            AND a.code = '5010') OR
    (e."categoryId" = 'travel'           AND a.code = '5020') OR
    (e."categoryId" = 'software'         AND a.code = '5030') OR
    (e."categoryId" = 'office-supplies'  AND a.code = '5040') OR
    (e."categoryId" = 'professional'     AND a.code = '5050') OR
    (e."categoryId" = 'rent'             AND a.code = '5060') OR
    (e."categoryId" = 'marketing'        AND a.code = '5070') OR
    (e."categoryId" = 'advertising'      AND a.code = '5070') OR
    (e."categoryId" = 'insurance'        AND a.code = '5080') OR
    (e."categoryId" = 'utilities'        AND a.code = '5090') OR
    (e."categoryId" = 'fees'             AND a.code = '5120') OR
    (e."categoryId" = 'shipping'         AND a.code = '5150') OR
    (e."categoryId" = 'inventory'        AND a.code = '5160')
  );

COMMIT;

\echo 'Accounts created (sample):'
SELECT "tenantId", code, name FROM plugin_agentbook_core."AbAccount"
  WHERE "accountType" = 'expense' AND "tenantId" = 'usr_maya_seed_001'
  ORDER BY code;

\echo 'Expense category rollup after relink:'
SELECT e."tenantId", a.name AS category, COUNT(*) AS rows, SUM(e."amountCents") AS total_cents
  FROM plugin_agentbook_expense."AbExpense" e
  LEFT JOIN plugin_agentbook_core."AbAccount" a ON a.id = e."categoryId"
  WHERE e."tenantId" IN ('usr_maya_seed_001','usr_alex_seed_002','usr_jordan_seed_003')
  GROUP BY e."tenantId", a.name
  ORDER BY e."tenantId", total_cents DESC;
