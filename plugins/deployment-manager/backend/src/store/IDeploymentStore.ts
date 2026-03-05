import type { DeploymentStatus, HealthStatus } from '../types/index.js';

export interface DeploymentRecord {
  id: string;
  name: string;
  teamId?: string;
  ownerUserId: string;
  providerSlug: string;
  providerMode: string;
  providerConfig?: Record<string, unknown>;
  connectorId?: string;
  gpuModel: string;
  gpuVramGb: number;
  gpuCount: number;
  cudaVersion?: string;
  artifactType: string;
  artifactVersion: string;
  dockerImage: string;
  healthPort?: number;
  healthEndpoint?: string;
  artifactConfig?: Record<string, unknown>;
  envVars?: Record<string, string>;
  concurrency?: number;
  estimatedCostPerHour?: number;
  status: DeploymentStatus;
  healthStatus: HealthStatus;
  providerDeploymentId?: string;
  endpointUrl?: string;
  sshHost?: string;
  sshPort?: number;
  sshUsername?: string;
  containerName?: string;
  templateId?: string;
  latestAvailableVersion?: string;
  hasUpdate: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastHealthCheck?: Date;
  deployedAt?: Date;
}

export interface StatusLogEntry {
  id: string;
  deploymentId: string;
  fromStatus?: DeploymentStatus;
  toStatus: DeploymentStatus;
  reason?: string;
  initiatedBy?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface DeploymentFilters {
  ownerUserId?: string;
  teamId?: string;
  status?: DeploymentStatus;
  providerSlug?: string;
}

export interface IDeploymentStore {
  create(record: DeploymentRecord): Promise<DeploymentRecord>;
  get(id: string): Promise<DeploymentRecord | undefined>;
  list(filters?: DeploymentFilters): Promise<DeploymentRecord[]>;
  update(id: string, data: Partial<DeploymentRecord>): Promise<DeploymentRecord>;
  remove(id: string): Promise<boolean>;

  addStatusLog(entry: StatusLogEntry): Promise<void>;
  getStatusLogs(deploymentId: string): Promise<StatusLogEntry[]>;
}
