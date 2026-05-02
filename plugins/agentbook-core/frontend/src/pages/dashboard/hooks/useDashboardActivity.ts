import { useEffect, useState, useCallback } from 'react';
import type { ActivityItem } from '../types';

export function useDashboardActivity(initialLimit = 10) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(initialLimit);

  const fetchActivity = useCallback(async (l: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/agentbook-core/dashboard/activity?limit=${l}`);
      if (!res.ok) throw new Error(`activity ${res.status}`);
      const json = await res.json();
      if (!json?.success) throw new Error(json?.error || 'activity failed');
      setItems(json.data);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchActivity(limit); }, [fetchActivity, limit]);

  return { items, error, loading, loadMore: () => setLimit(l => l + 10) };
}
