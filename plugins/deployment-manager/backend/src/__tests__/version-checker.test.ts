import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VersionCheckerService } from '../services/VersionCheckerService.js';
import type { DeploymentOrchestrator } from '../services/DeploymentOrchestrator.js';
import type { DeploymentRecord } from '../services/DeploymentOrchestrator.js';
import type { TemplateRegistry, TemplateVersion } from '../services/TemplateRegistry.js';

function makeDeploymentRecord(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
  return {
    id: 'dep-1',
    name: 'test-deployment',
    ownerUserId: 'user-1',
    providerSlug: 'mock',
    providerMode: 'serverless',
    gpuModel: 'A100',
    gpuVramGb: 80,
    gpuCount: 1,
    artifactType: 'ai-runner',
    artifactVersion: 'v0.14.0',
    dockerImage: 'livepeer/ai-runner:v0.14.0',
    status: 'ONLINE',
    healthStatus: 'GREEN',
    hasUpdate: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMockOrchestrator(deployments: DeploymentRecord[]): DeploymentOrchestrator {
  return {
    list: vi.fn().mockResolvedValue(deployments),
    get: vi.fn().mockImplementation(async (id: string) =>
      deployments.find((d) => d.id === id) || null,
    ),
  } as unknown as DeploymentOrchestrator;
}

function makeMockTemplateRegistry(
  latestVersionMap: Record<string, TemplateVersion | null>,
): TemplateRegistry {
  return {
    getLatestVersion: vi.fn().mockImplementation(async (templateId: string) =>
      latestVersionMap[templateId] ?? null,
    ),
  } as unknown as TemplateRegistry;
}

describe('VersionCheckerService', () => {
  let checker: VersionCheckerService;
  let orchestrator: ReturnType<typeof makeMockOrchestrator>;
  let templateRegistry: ReturnType<typeof makeMockTemplateRegistry>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should set hasUpdate=true when a newer version exists', async () => {
    const deployment = makeDeploymentRecord({ artifactVersion: 'v0.14.0' });
    orchestrator = makeMockOrchestrator([deployment]);
    templateRegistry = makeMockTemplateRegistry({
      'ai-runner': {
        version: 'v0.15.0',
        publishedAt: '2025-06-01',
        prerelease: false,
        releaseUrl: 'https://github.com/livepeer/ai-runner/releases/tag/v0.15.0',
        dockerImage: 'livepeer/ai-runner:v0.15.0',
      },
    });
    checker = new VersionCheckerService(orchestrator, templateRegistry, 999_999);

    await checker.checkAll();

    expect(deployment.hasUpdate).toBe(true);
    expect(deployment.latestAvailableVersion).toBe('v0.15.0');
  });

  it('should set hasUpdate=false when already on latest version', async () => {
    const deployment = makeDeploymentRecord({ artifactVersion: 'v0.15.0' });
    orchestrator = makeMockOrchestrator([deployment]);
    templateRegistry = makeMockTemplateRegistry({
      'ai-runner': {
        version: 'v0.15.0',
        publishedAt: '2025-06-01',
        prerelease: false,
        releaseUrl: '',
        dockerImage: 'livepeer/ai-runner:v0.15.0',
      },
    });
    checker = new VersionCheckerService(orchestrator, templateRegistry, 999_999);

    await checker.checkAll();

    expect(deployment.hasUpdate).toBe(false);
    expect(deployment.latestAvailableVersion).toBe('v0.15.0');
  });

  it('should skip non-ONLINE deployments', async () => {
    const pendingDep = makeDeploymentRecord({ id: 'dep-pending', status: 'PENDING' });
    const failedDep = makeDeploymentRecord({ id: 'dep-failed', status: 'FAILED' });
    const onlineDep = makeDeploymentRecord({ id: 'dep-online', status: 'ONLINE', artifactVersion: 'v0.14.0' });

    orchestrator = makeMockOrchestrator([pendingDep, failedDep, onlineDep]);
    templateRegistry = makeMockTemplateRegistry({
      'ai-runner': {
        version: 'v0.15.0',
        publishedAt: '',
        prerelease: false,
        releaseUrl: '',
        dockerImage: 'livepeer/ai-runner:v0.15.0',
      },
    });
    checker = new VersionCheckerService(orchestrator, templateRegistry, 999_999);

    await checker.checkAll();

    expect(pendingDep.hasUpdate).toBe(false);
    expect(failedDep.hasUpdate).toBe(false);
    expect(onlineDep.hasUpdate).toBe(true);
  });

  it('should check a single deployment with checkOne', async () => {
    const deployment = makeDeploymentRecord({ id: 'dep-1', artifactVersion: 'v0.14.0' });
    orchestrator = makeMockOrchestrator([deployment]);
    templateRegistry = makeMockTemplateRegistry({
      'ai-runner': {
        version: 'v0.15.0',
        publishedAt: '',
        prerelease: false,
        releaseUrl: '',
        dockerImage: 'livepeer/ai-runner:v0.15.0',
      },
    });
    checker = new VersionCheckerService(orchestrator, templateRegistry, 999_999);

    const result = await checker.checkOne('dep-1');

    expect(result.hasUpdate).toBe(true);
    expect(result.currentVersion).toBe('v0.14.0');
    expect(result.latestVersion).toBe('v0.15.0');
  });

  it('should throw when checkOne is called with unknown deployment', async () => {
    orchestrator = makeMockOrchestrator([]);
    templateRegistry = makeMockTemplateRegistry({});
    checker = new VersionCheckerService(orchestrator, templateRegistry, 999_999);

    await expect(checker.checkOne('nonexistent')).rejects.toThrow('Deployment not found');
  });

  it('should handle getLatestVersion returning null gracefully', async () => {
    const deployment = makeDeploymentRecord({ artifactVersion: 'v0.14.0' });
    orchestrator = makeMockOrchestrator([deployment]);
    templateRegistry = makeMockTemplateRegistry({ 'ai-runner': null });
    checker = new VersionCheckerService(orchestrator, templateRegistry, 999_999);

    await checker.checkAll();

    expect(deployment.hasUpdate).toBe(false);
    expect(deployment.latestAvailableVersion).toBeUndefined();
  });

  it('should handle template not found for checkOne gracefully', async () => {
    const deployment = makeDeploymentRecord({
      id: 'dep-1',
      artifactType: 'unknown-template',
      artifactVersion: 'v1.0.0',
    });
    orchestrator = makeMockOrchestrator([deployment]);
    templateRegistry = makeMockTemplateRegistry({});
    checker = new VersionCheckerService(orchestrator, templateRegistry, 999_999);

    const result = await checker.checkOne('dep-1');

    expect(result.hasUpdate).toBe(false);
    expect(result.currentVersion).toBe('v1.0.0');
    expect(result.latestVersion).toBeUndefined();
  });
});
