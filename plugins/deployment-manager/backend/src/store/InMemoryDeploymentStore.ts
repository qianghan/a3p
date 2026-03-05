import type {
  IDeploymentStore,
  DeploymentRecord,
  DeploymentFilters,
  StatusLogEntry,
} from './IDeploymentStore.js';

export class InMemoryDeploymentStore implements IDeploymentStore {
  private deployments = new Map<string, DeploymentRecord>();
  private statusLogs: StatusLogEntry[] = [];

  async create(record: DeploymentRecord): Promise<DeploymentRecord> {
    this.deployments.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<DeploymentRecord | undefined> {
    return this.deployments.get(id);
  }

  async list(filters?: DeploymentFilters): Promise<DeploymentRecord[]> {
    let results = Array.from(this.deployments.values());

    if (filters?.ownerUserId) {
      results = results.filter((d) => d.ownerUserId === filters.ownerUserId);
    }
    if (filters?.teamId) {
      results = results.filter((d) => d.teamId === filters.teamId);
    }
    if (filters?.status) {
      results = results.filter((d) => d.status === filters.status);
    }
    if (filters?.providerSlug) {
      results = results.filter((d) => d.providerSlug === filters.providerSlug);
    }

    return results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async update(id: string, data: Partial<DeploymentRecord>): Promise<DeploymentRecord> {
    const existing = this.deployments.get(id);
    if (!existing) throw new Error(`Deployment not found: ${id}`);

    const updated = { ...existing, ...data, updatedAt: new Date() };
    this.deployments.set(id, updated);
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    return this.deployments.delete(id);
  }

  async addStatusLog(entry: StatusLogEntry): Promise<void> {
    this.statusLogs.push(entry);
  }

  async getStatusLogs(deploymentId: string): Promise<StatusLogEntry[]> {
    return this.statusLogs
      .filter((l) => l.deploymentId === deploymentId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}
