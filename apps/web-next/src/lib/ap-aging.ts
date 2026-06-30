/** Pure AP-aging bucket logic, shared by the report route and its tests. */
export type AgingBucket = 'current' | 'd1_30' | 'd31_60' | 'd60_plus';

export function bucketFor(dueDate: Date, now: Date): AgingBucket {
  const days = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  return 'd60_plus';
}
