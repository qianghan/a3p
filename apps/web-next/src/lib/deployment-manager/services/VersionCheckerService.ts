import type { DeploymentOrchestrator } from './DeploymentOrchestrator';
import type { ArtifactRegistry } from './ArtifactRegistry';

export class VersionCheckerService {
  constructor(
    private orchestrator: DeploymentOrchestrator,
    private artifactRegistry: ArtifactRegistry,
  ) {}

  async checkAll(): Promise<void> {
    const deployments = await this.orchestrator.list();
    const active = deployments.filter((d) => ['ONLINE', 'DEGRADED', 'OFFLINE'].includes(d.status));
    const latestVersions = new Map<string, string>();

    for (const deployment of active) {
      if (!latestVersions.has(deployment.artifactType)) {
        const latest = await this.artifactRegistry.getLatestVersion(deployment.artifactType);
        if (latest) latestVersions.set(deployment.artifactType, latest.version);
      }
      const latestVersion = latestVersions.get(deployment.artifactType);
      if (latestVersion && latestVersion !== deployment.artifactVersion) {
        deployment.latestAvailableVersion = latestVersion;
        deployment.hasUpdate = true;
      } else {
        deployment.hasUpdate = false;
        deployment.latestAvailableVersion = latestVersion || undefined;
      }
    }
  }

  async checkOne(deploymentId: string): Promise<{ hasUpdate: boolean; currentVersion: string; latestVersion?: string }> {
    const deployment = await this.orchestrator.get(deploymentId);
    if (!deployment) throw new Error(`Deployment not found: ${deploymentId}`);
    const latest = await this.artifactRegistry.getLatestVersion(deployment.artifactType);
    if (latest && latest.version !== deployment.artifactVersion) {
      deployment.latestAvailableVersion = latest.version;
      deployment.hasUpdate = true;
      return { hasUpdate: true, currentVersion: deployment.artifactVersion, latestVersion: latest.version };
    }
    deployment.hasUpdate = false;
    return { hasUpdate: false, currentVersion: deployment.artifactVersion, latestVersion: latest?.version };
  }
}
