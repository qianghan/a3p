import { ProviderAdapterRegistry } from './services/ProviderAdapterRegistry';
import { DeploymentOrchestrator } from './services/DeploymentOrchestrator';
import { AuditService } from './services/AuditService';
import { ArtifactRegistry } from './services/ArtifactRegistry';
import { HealthMonitorService } from './services/HealthMonitorService';
import { VersionCheckerService } from './services/VersionCheckerService';
import { RequestUsageService } from './services/RequestUsageService';

import { RunPodAdapter } from './adapters/RunPodAdapter';
import { FalAdapter } from './adapters/FalAdapter';
import { BasetenAdapter } from './adapters/BasetenAdapter';
import { ModalAdapter } from './adapters/ModalAdapter';
import { ReplicateAdapter } from './adapters/ReplicateAdapter';
import { SshBridgeAdapter } from './adapters/SshBridgeAdapter';

export type { IProviderAdapter } from './adapters/IProviderAdapter';
export type { GithubReleasesAdapter, ReleaseInfo } from './adapters/GithubReleasesAdapter';
export type { ArtifactDefinition, ArtifactVersion } from './services/ArtifactRegistry';
export { DeploymentOrchestrator } from './services/DeploymentOrchestrator';
export { ProviderAdapterRegistry } from './services/ProviderAdapterRegistry';
export { AuditService } from './services/AuditService';
export { ArtifactRegistry } from './services/ArtifactRegistry';
export { HealthMonitorService } from './services/HealthMonitorService';
export { VersionCheckerService } from './services/VersionCheckerService';
export { RequestUsageService } from './services/RequestUsageService';
export * from './types';
export * from './validation';

interface DmServices {
  registry: ProviderAdapterRegistry;
  orchestrator: DeploymentOrchestrator;
  audit: AuditService;
  artifactRegistry: ArtifactRegistry;
  healthMonitor: HealthMonitorService;
  versionChecker: VersionCheckerService;
  usageService: RequestUsageService;
}

let _services: DmServices | null = null;

/**
 * Lazy singleton initialization of all deployment-manager services.
 * Stateless adapter classes are instantiated once per process.
 * In serverless, each cold start gets a new set of instances,
 * which is fine because all state lives in the database.
 */
export function getServices(): DmServices {
  if (_services) return _services;

  const registry = new ProviderAdapterRegistry();
  registry.register(new RunPodAdapter());
  registry.register(new FalAdapter());
  registry.register(new BasetenAdapter());
  registry.register(new ModalAdapter());
  registry.register(new ReplicateAdapter());
  registry.register(new SshBridgeAdapter());

  const audit = new AuditService();
  const orchestrator = new DeploymentOrchestrator(registry, audit);
  const artifactRegistry = new ArtifactRegistry();
  const healthMonitor = new HealthMonitorService(registry, orchestrator);
  const versionChecker = new VersionCheckerService(orchestrator, artifactRegistry);
  const usageService = new RequestUsageService();

  _services = {
    registry,
    orchestrator,
    audit,
    artifactRegistry,
    healthMonitor,
    versionChecker,
    usageService,
  };

  return _services;
}
