import { useEffect, useState } from 'react';

/** The tenant's configured currency (e.g. 'USD', 'AUD'), defaulting to 'USD' until loaded. */
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
