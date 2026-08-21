import { useEffect, useState } from 'react';

/**
 * The tenant's configured currency (e.g. 'USD', 'AUD'), defaulting to 'USD'
 * until loaded.
 *
 * THIS IS THE FOURTH IDENTICAL COPY of this hook — agentbook-core,
 * agentbook-expense, agentbook-invoice and agentbook-tax each have one. Added
 * here for consistency rather than inventing a different mechanism in one
 * plugin, but the duplication is the wrong shape.
 *
 * The right fix is to expose `currency` on `II18nService` in
 * packages/plugin-sdk: the shell ALREADY resolves it (use-shell-i18n.ts returns
 * `currency` on its own ShellI18n object) and simply does not surface it to
 * plugins, which is why every plugin re-fetches /tenant-config for a value the
 * shell is holding. That change would delete all four copies and one redundant
 * request per page. Left out of this change deliberately: it touches the SDK
 * interface, the shell binding and four plugins, which is its own PR.
 *
 * Defaults to 'USD' rather than '' on purpose: Intl.NumberFormat with
 * style:'currency' and an empty currency throws, so an empty default would
 * crash every money figure on first render.
 */
export function useTenantCurrency(): string {
  const [currency, setCurrency] = useState('USD');
  useEffect(() => {
    fetch('/api/v1/agentbook-core/tenant-config')
      .then((r) => r.json())
      .then((j) => { if (j?.data?.currency) setCurrency(j.data.currency); })
      .catch(() => {});
  }, []);
  return currency;
}
