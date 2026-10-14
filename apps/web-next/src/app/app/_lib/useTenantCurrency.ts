'use client';
import { useMobileData } from './useMobileData';
import { getTenantCurrency } from './api-extra';

/** ISO currency for the tenant, or null until known — never a guessed 'USD'. */
export function useTenantCurrency(): string | null {
  const { data } = useMobileData<string>('tenant-currency', getTenantCurrency);
  return data ?? null;
}
