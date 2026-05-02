import { useEffect, useState, useCallback } from 'react';
import type { OverviewPayload } from '../types';

interface State {
  data: OverviewPayload | null;
  error: Error | null;
  loading: boolean;
}

export function useDashboardOverview() {
  const [state, setState] = useState<State>({ data: null, error: null, loading: true });

  const fetchOverview = useCallback(async () => {
    setState(s => ({ ...s, loading: true }));
    try {
      const res = await fetch('/api/v1/agentbook-core/dashboard/overview');
      if (!res.ok) throw new Error(`overview ${res.status}`);
      const json = await res.json();
      if (!json?.success) throw new Error(json?.error || 'overview failed');
      setState({ data: json.data, error: null, loading: false });
    } catch (err) {
      setState({ data: null, error: err as Error, loading: false });
    }
  }, []);

  useEffect(() => { fetchOverview(); }, [fetchOverview]);

  return { ...state, refetch: fetchOverview };
}
