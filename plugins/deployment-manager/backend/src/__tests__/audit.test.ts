import { describe, it, expect, beforeEach } from 'vitest';
import { AuditService } from '../services/AuditService.js';
import type { AuditEntry } from '../services/AuditService.js';

describe('AuditService', () => {
  let audit: AuditService;

  const makeEntry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
    action: 'CREATE',
    resource: 'deployment',
    userId: 'user-1',
    status: 'success',
    ...overrides,
  });

  beforeEach(() => {
    audit = new AuditService();
  });

  it('should create entry with auto-generated id and timestamp', async () => {
    await audit.log(makeEntry());
    const { data } = await audit.query({});
    expect(data).toHaveLength(1);
    expect(data[0].id).toBeDefined();
    expect(typeof data[0].id).toBe('string');
    expect(data[0].id.length).toBeGreaterThan(0);
    expect(data[0].createdAt).toBeInstanceOf(Date);
  });

  it('should return all entries when no filters are provided', async () => {
    await audit.log(makeEntry({ userId: 'user-1' }));
    await audit.log(makeEntry({ userId: 'user-2' }));
    await audit.log(makeEntry({ userId: 'user-3' }));
    const { data, total } = await audit.query({});
    expect(data).toHaveLength(3);
    expect(total).toBe(3);
  });

  it('should filter by deploymentId', async () => {
    await audit.log(makeEntry({ deploymentId: 'dep-1' }));
    await audit.log(makeEntry({ deploymentId: 'dep-2' }));
    await audit.log(makeEntry({ deploymentId: 'dep-1' }));
    const { data, total } = await audit.query({ deploymentId: 'dep-1' });
    expect(data).toHaveLength(2);
    expect(total).toBe(2);
    expect(data.every((d) => d.deploymentId === 'dep-1')).toBe(true);
  });

  it('should filter by userId', async () => {
    await audit.log(makeEntry({ userId: 'user-a' }));
    await audit.log(makeEntry({ userId: 'user-b' }));
    await audit.log(makeEntry({ userId: 'user-a' }));
    const { data } = await audit.query({ userId: 'user-a' });
    expect(data).toHaveLength(2);
    expect(data.every((d) => d.userId === 'user-a')).toBe(true);
  });

  it('should filter by action', async () => {
    await audit.log(makeEntry({ action: 'CREATE' }));
    await audit.log(makeEntry({ action: 'DEPLOY' }));
    await audit.log(makeEntry({ action: 'DESTROY' }));
    const { data } = await audit.query({ action: 'DEPLOY' });
    expect(data).toHaveLength(1);
    expect(data[0].action).toBe('DEPLOY');
  });

  it('should paginate with limit and offset', async () => {
    for (let i = 0; i < 10; i++) {
      await audit.log(makeEntry({ resourceId: `r-${i}` }));
    }
    const { data } = await audit.query({ limit: 3, offset: 2 });
    expect(data).toHaveLength(3);
  });

  it('should return total count independent of pagination', async () => {
    for (let i = 0; i < 10; i++) {
      await audit.log(makeEntry());
    }
    const { data, total } = await audit.query({ limit: 3, offset: 0 });
    expect(data).toHaveLength(3);
    expect(total).toBe(10);
  });

  it('should return empty data and zero total for empty store', async () => {
    const { data, total } = await audit.query({});
    expect(data).toHaveLength(0);
    expect(total).toBe(0);
  });

  it('should sort results by createdAt descending (newest first)', async () => {
    await audit.log(makeEntry({ resourceId: 'first' }));
    await audit.log(makeEntry({ resourceId: 'second' }));
    await audit.log(makeEntry({ resourceId: 'third' }));
    const { data } = await audit.query({});
    expect(data[0].createdAt.getTime()).toBeGreaterThanOrEqual(data[1].createdAt.getTime());
    expect(data[1].createdAt.getTime()).toBeGreaterThanOrEqual(data[2].createdAt.getTime());
  });

  it('should default limit to 50 when not specified', async () => {
    for (let i = 0; i < 60; i++) {
      await audit.log(makeEntry());
    }
    const { data, total } = await audit.query({});
    expect(data).toHaveLength(50);
    expect(total).toBe(60);
  });
});
