import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDeploymentStore } from '../../store/InMemoryDeploymentStore.js';
import type { DeploymentRecord, StatusLogEntry } from '../../store/IDeploymentStore.js';

function makeRecord(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    id: crypto.randomUUID(),
    name: 'test',
    ownerUserId: 'user-1',
    providerSlug: 'fal-ai',
    providerMode: 'serverless',
    gpuModel: 'A100',
    gpuVramGb: 80,
    gpuCount: 1,
    artifactType: 'ai-runner',
    artifactVersion: 'v1.0',
    dockerImage: 'test:v1.0',
    status: 'PENDING',
    healthStatus: 'UNKNOWN',
    hasUpdate: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('Feature: Persistent Storage via IDeploymentStore', () => {
  let store: InMemoryDeploymentStore;

  beforeEach(() => {
    store = new InMemoryDeploymentStore();
  });

  it('Scenario: Full lifecycle through store — create, update status, query, destroy', async () => {
    const record = makeRecord({ id: 'dep-lifecycle' });
    await store.create(record);

    await store.update('dep-lifecycle', { status: 'DEPLOYING' });
    await store.addStatusLog({
      id: '1',
      deploymentId: 'dep-lifecycle',
      fromStatus: 'PENDING',
      toStatus: 'DEPLOYING',
      createdAt: new Date('2024-01-01'),
    } as StatusLogEntry);

    await store.update('dep-lifecycle', { status: 'ONLINE', healthStatus: 'GREEN' });
    await store.addStatusLog({
      id: '2',
      deploymentId: 'dep-lifecycle',
      fromStatus: 'DEPLOYING',
      toStatus: 'ONLINE',
      createdAt: new Date('2024-02-01'),
    } as StatusLogEntry);

    const onlineList = await store.list({ status: 'ONLINE' });
    expect(onlineList).toHaveLength(1);
    expect(onlineList[0].healthStatus).toBe('GREEN');

    const logs = await store.getStatusLogs('dep-lifecycle');
    expect(logs).toHaveLength(2);
    expect(logs[0].toStatus).toBe('ONLINE');

    await store.update('dep-lifecycle', { status: 'DESTROYED' });
    const destroyedList = await store.list({ status: 'DESTROYED' });
    expect(destroyedList).toHaveLength(1);
  });

  it('Scenario: Store preserves envVars, concurrency, and estimatedCostPerHour', async () => {
    const record = makeRecord({
      id: 'dep-env',
      envVars: { API_KEY: 'secret', DEBUG: 'true' },
      concurrency: 5,
      estimatedCostPerHour: 3.50,
    });
    await store.create(record);

    const retrieved = await store.get('dep-env');
    expect(retrieved!.envVars).toEqual({ API_KEY: 'secret', DEBUG: 'true' });
    expect(retrieved!.concurrency).toBe(5);
    expect(retrieved!.estimatedCostPerHour).toBe(3.50);
  });

  it('Scenario: Multiple deployments with different owners', async () => {
    await store.create(makeRecord({ id: '1', ownerUserId: 'alice', status: 'ONLINE' }));
    await store.create(makeRecord({ id: '2', ownerUserId: 'bob', status: 'ONLINE' }));
    await store.create(makeRecord({ id: '3', ownerUserId: 'alice', status: 'FAILED' }));

    const aliceDeployments = await store.list({ ownerUserId: 'alice' });
    expect(aliceDeployments).toHaveLength(2);

    const aliceOnline = await store.list({ ownerUserId: 'alice', status: 'ONLINE' });
    expect(aliceOnline).toHaveLength(1);
    expect(aliceOnline[0].id).toBe('1');
  });

  it('Scenario: Status logs are isolated per deployment', async () => {
    await store.create(makeRecord({ id: 'dep-a' }));
    await store.create(makeRecord({ id: 'dep-b' }));

    await store.addStatusLog({ id: '1', deploymentId: 'dep-a', toStatus: 'PENDING', createdAt: new Date() } as StatusLogEntry);
    await store.addStatusLog({ id: '2', deploymentId: 'dep-a', toStatus: 'DEPLOYING', createdAt: new Date() } as StatusLogEntry);
    await store.addStatusLog({ id: '3', deploymentId: 'dep-b', toStatus: 'PENDING', createdAt: new Date() } as StatusLogEntry);

    const logsA = await store.getStatusLogs('dep-a');
    const logsB = await store.getStatusLogs('dep-b');

    expect(logsA).toHaveLength(2);
    expect(logsB).toHaveLength(1);
  });

  it('Scenario: Update preserves fields not included in the partial', async () => {
    await store.create(makeRecord({
      id: 'dep-partial',
      name: 'original-name',
      envVars: { KEY: 'value' },
      concurrency: 3,
    }));

    await store.update('dep-partial', { status: 'DEPLOYING' });

    const record = await store.get('dep-partial');
    expect(record!.name).toBe('original-name');
    expect(record!.envVars).toEqual({ KEY: 'value' });
    expect(record!.concurrency).toBe(3);
    expect(record!.status).toBe('DEPLOYING');
  });

  it('Scenario: Remove cleans up the deployment', async () => {
    await store.create(makeRecord({ id: 'dep-remove' }));
    expect(await store.get('dep-remove')).toBeDefined();

    const removed = await store.remove('dep-remove');
    expect(removed).toBe(true);
    expect(await store.get('dep-remove')).toBeUndefined();

    const list = await store.list();
    expect(list).toHaveLength(0);
  });
});
