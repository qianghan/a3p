import React, { useState, useEffect } from 'react';

const API_BASE = '/api/v1/deployment-manager';

interface StatusEntry {
  id: string;
  fromStatus?: string;
  toStatus: string;
  reason?: string;
  initiatedBy?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

interface StatusTimelineProps {
  deploymentId: string;
}

const dotColor = (status: string) => {
  if (status === 'ONLINE') return '#4ade80';
  if (status === 'FAILED') return '#f87171';
  if (status === 'DESTROYED') return '#6b7280';
  if (status === 'DEPLOYING' || status === 'PROVISIONING' || status === 'VALIDATING') return '#facc15';
  return 'var(--dm-accent-blue)';
};

const ProviderDetails: React.FC<{ meta: Record<string, unknown> }> = ({ meta }) => {
  const details: string[] = [];

  if (meta.providerReportedStatus) details.push(`Provider: ${meta.providerReportedStatus}`);
  if (meta.dockerImage) details.push(`Image: ${meta.dockerImage}`);
  if (meta.gpuModel) details.push(`GPU: ${meta.gpuModel}${meta.gpuCount ? ` ×${meta.gpuCount}` : ''}`);
  if (meta.providerDeploymentId) details.push(`Endpoint: ${meta.providerDeploymentId}`);

  const workers = meta.workers as Record<string, number> | undefined;
  const workersRunning = meta.workersRunning ?? workers?.running;
  const workersTotal = meta.workersTotal ?? workers?.total;
  if (workersRunning != null && workersTotal != null) {
    details.push(`Workers: ${workersRunning}/${workersTotal} running`);
  }

  if (meta.endpointUrl) details.push(`URL: ${meta.endpointUrl}`);

  const error = meta.error as string | undefined;
  if (error) details.push(`Error: ${error}`);

  if (details.length === 0) return null;

  return (
    <div style={{
      fontSize: '0.7rem',
      color: 'var(--dm-text-tertiary)',
      marginTop: '0.25rem',
      paddingLeft: '0.5rem',
      borderLeft: '2px solid var(--dm-border)',
    }}>
      {details.map((d, i) => <div key={i}>{d}</div>)}
    </div>
  );
};

export const StatusTimeline: React.FC<StatusTimelineProps> = ({ deploymentId }) => {
  const [entries, setEntries] = useState<StatusEntry[]>([]);

  useEffect(() => {
    let active = true;
    const fetchHistory = () => {
      fetch(`${API_BASE}/deployments/${deploymentId}/history`)
        .then((r) => r.json())
        .then((d) => { if (d.success && active) setEntries(d.data); })
        .catch(() => {});
    };
    fetchHistory();
    const timer = setInterval(fetchHistory, 8000);
    return () => { active = false; clearInterval(timer); };
  }, [deploymentId]);

  if (entries.length === 0) {
    return <p style={{ color: 'var(--dm-text-tertiary)', fontSize: '0.875rem' }}>No status history</p>;
  }

  return (
    <div style={{ position: 'relative', paddingLeft: '1.5rem' }}>
      <div style={{
        position: 'absolute',
        left: '0.35rem',
        top: 0,
        bottom: 0,
        width: '2px',
        background: 'var(--dm-border)',
      }} />
      {entries.map((entry) => (
        <div key={entry.id} style={{ position: 'relative', paddingBottom: '1rem' }}>
          <div style={{
            position: 'absolute',
            left: '-1.15rem',
            top: '0.25rem',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: dotColor(entry.toStatus),
          }} />
          <div style={{ fontSize: '0.875rem', color: 'var(--dm-text-primary)' }}>
            <span style={{ fontWeight: 600, color: 'var(--dm-text-primary)' }}>{entry.toStatus}</span>
            {entry.fromStatus && entry.fromStatus !== entry.toStatus && (
              <span style={{ color: 'var(--dm-text-tertiary)' }}> from {entry.fromStatus}</span>
            )}
          </div>
          {entry.reason && (
            <div style={{ fontSize: '0.75rem', color: 'var(--dm-text-secondary)' }}>{entry.reason}</div>
          )}
          {entry.metadata && <ProviderDetails meta={entry.metadata} />}
          <div style={{ fontSize: '0.7rem', color: 'var(--dm-text-tertiary)' }}>
            {new Date(entry.createdAt).toLocaleString()}
            {entry.initiatedBy && entry.initiatedBy !== 'system' && ` by ${entry.initiatedBy}`}
          </div>
        </div>
      ))}
    </div>
  );
};
