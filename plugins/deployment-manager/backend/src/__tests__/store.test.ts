import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDeploymentStore } from '../store/InMemoryDeploymentStore.js';
import type { DeploymentRecord, StatusLogEntry } from '../store/IDeploymentStore.js';

function makeRecord(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    id: crypto.randomUUID(),
    name: 'test-deployment',
    ownerUserId: 'user-1',
    providerSlug: 'fal-ai',
    providerMode: 'serverless',
    gpuModel: 'A100',
    gpuVramGb: 80,
    gpuCount: 1,
    artifactType: 'ai-runner',
    artifactVersion: 'v1.0',
    dockerImage: 'livepeer/ai-runner:v1.0',
    status: 'PENDING',
    healthStatus: 'UNKNOWN',
    hasUpdate: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('InMemoryDeploymentStore', () => {
  let store: InMemoryDeploymentStore;

  beforeEach(() => {
    store = new InMemoryDeploymentStore();
  });

  it('creates and retrieves a record', async () => {
    const record = makeRecord();
    const created = await store.create(record);
    expect(created.id).toBe(record.id);
    const got = await store.get(record.id);
    expect(got).toBeDefined();
    expect(got!.name).toBe('test-deployment');
  });

  it('returns undefined for missing record', async () => {
    const got = await store.get('nonexistent');
    expect(got).toBeUndefined();
  });

  it('lists all records sorted by createdAt desc', async () => {
    const r1 = makeRecord({ id: '1', createdAt: new Date('2024-01-01') });
    const r2 = makeRecord({ id: '2', createdAt: new Date('2024-06-01') });
    await store.create(r1);
    await store.create(r2);
    const all = await store.list();
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe('2');
  });

  it('filters by ownerUserId', async () => {
    await store.create(makeRecord({ id: '1', ownerUserId: 'alice' }));
    await store.create(makeRecord({ id: '2', ownerUserId: 'bob' }));
    const filtered = await store.list({ ownerUserId: 'alice' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].ownerUserId).toBe('alice');
  });

  it('filters by status', async () => {
    await store.create(makeRecord({ id: '1', status: 'ONLINE' }));
    await store.create(makeRecord({ id: '2', status: 'FAILED' }));
    const filtered = await store.list({ status: 'ONLINE' });
    expect(filtered).toHaveLength(1);
  });

  it('filters by teamId', async () => {
    await store.create(makeRecord({ id: '1', teamId: 'team-x' }));
    await store.create(makeRecord({ id: '2', teamId: 'team-y' }));
    const filtered = await store.list({ teamId: 'team-x' });
    expect(filtered).toHaveLength(1);
  });

  it('filters by providerSlug', async () => {
    await store.create(makeRecord({ id: '1', providerSlug: 'fal-ai' }));
    await store.create(makeRecord({ id: '2', providerSlug: 'runpod' }));
    const filtered = await store.list({ providerSlug: 'runpod' });
    expect(filtered).toHaveLength(1);
  });

  it('updates a record and returns updated version', async () => {
    await store.create(makeRecord({ id: '1', status: 'PENDING' }));
    const updated = await store.update('1', { status: 'DEPLOYING' });
    expect(updated.status).toBe('DEPLOYING');
    const got = await store.get('1');
    expect(got!.status).toBe('DEPLOYING');
  });

  it('sets updatedAt on update', async () => {
    const old = new Date('2024-01-01');
    await store.create(makeRecord({ id: '1', updatedAt: old }));
    const updated = await store.update('1', { status: 'DEPLOYING' });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it('throws when updating non-existent record', async () => {
    await expect(store.update('nonexistent', { status: 'ONLINE' })).rejects.toThrow('Deployment not found: nonexistent');
  });

  it('removes a record', async () => {
    await store.create(makeRecord({ id: '1' }));
    const removed = await store.remove('1');
    expect(removed).toBe(true);
    const got = await store.get('1');
    expect(got).toBeUndefined();
  });

  it('returns false when removing non-existent record', async () => {
    const removed = await store.remove('nonexistent');
    expect(removed).toBe(false);
  });

  it('adds and retrieves status logs', async () => {
    const entry: StatusLogEntry = {
      id: 'log-1',
      deploymentId: 'dep-1',
      fromStatus: undefined,
      toStatus: 'PENDING',
      reason: 'Created',
      initiatedBy: 'user-1',
      createdAt: new Date(),
    };
    await store.addStatusLog(entry);
    const logs = await store.getStatusLogs('dep-1');
    expect(logs).toHaveLength(1);
    expect(logs[0].toStatus).toBe('PENDING');
  });

  it('returns status logs sorted by createdAt desc', async () => {
    await store.addStatusLog({ id: '1', deploymentId: 'dep-1', toStatus: 'PENDING', createdAt: new Date('2024-01-01') } as StatusLogEntry);
    await store.addStatusLog({ id: '2', deploymentId: 'dep-1', toStatus: 'DEPLOYING', createdAt: new Date('2024-06-01') } as StatusLogEntry);
    const logs = await store.getStatusLogs('dep-1');
    expect(logs[0].id).toBe('2');
  });

  it('filters status logs by deploymentId', async () => {
    await store.addStatusLog({ id: '1', deploymentId: 'dep-1', toStatus: 'PENDING', createdAt: new Date() } as StatusLogEntry);
    await store.addStatusLog({ id: '2', deploymentId: 'dep-2', toStatus: 'PENDING', createdAt: new Date() } as StatusLogEntry);
    const logs = await store.getStatusLogs('dep-1');
    expect(logs).toHaveLength(1);
  });

  it('combines multiple filters', async () => {
    await store.create(makeRecord({ id: '1', ownerUserId: 'alice', status: 'ONLINE', providerSlug: 'fal-ai' }));
    await store.create(makeRecord({ id: '2', ownerUserId: 'alice', status: 'FAILED', providerSlug: 'fal-ai' }));
    await store.create(makeRecord({ id: '3', ownerUserId: 'bob', status: 'ONLINE', providerSlug: 'runpod' }));
    const filtered = await store.list({ ownerUserId: 'alice', status: 'ONLINE' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('1');
  });
});
