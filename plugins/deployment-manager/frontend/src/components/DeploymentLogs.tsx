import React, { useState, useEffect, useRef } from 'react';
import { Terminal } from 'lucide-react';

interface DestroyStep {
  resource: string;
  resourceId?: string;
  action: string;
  status: 'ok' | 'failed' | 'skipped';
  detail?: string;
  error?: string;
}

interface LogEntry {
  createdAt: string;
  fromStatus?: string;
  toStatus: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

interface DeploymentLogsProps {
  deploymentId: string;
  autoScroll?: boolean;
}

const API_BASE = '/api/v1/deployment-manager';

const stepIcon = (status: string) => {
  if (status === 'ok') return { symbol: '✓', color: '#4ade80' };
  if (status === 'failed') return { symbol: '✗', color: '#f87171' };
  return { symbol: '–', color: '#6b7280' };
};

const statusColor = (status: string) => {
  if (status === 'ONLINE') return '#4ade80';
  if (status === 'FAILED') return '#f87171';
  if (status === 'DESTROYED') return '#6b7280';
  if (['DEPLOYING', 'PROVISIONING', 'VALIDATING', 'DESTROYING'].includes(status)) return '#facc15';
  return '#e5e7eb';
};

const ProviderMetaLine: React.FC<{ meta: Record<string, unknown> }> = ({ meta }) => {
  const parts: string[] = [];

  if (meta.providerReportedStatus) parts.push(`status=${meta.providerReportedStatus}`);
  if (meta.dockerImage) parts.push(`image=${meta.dockerImage}`);
  if (meta.gpuModel) parts.push(`gpu=${meta.gpuModel}${meta.gpuCount ? `×${meta.gpuCount}` : ''}`);

  const workers = meta.workers as Record<string, number> | undefined;
  const running = meta.workersRunning ?? workers?.running;
  const total = meta.workersTotal ?? workers?.total;
  if (running != null && total != null) parts.push(`workers=${running}/${total}`);

  if (meta.providerDeploymentId) parts.push(`endpoint=${meta.providerDeploymentId}`);
  if (meta.endpointUrl) parts.push(`url=${meta.endpointUrl}`);

  const error = meta.error as string | undefined;
  if (error) parts.push(`error="${error}"`);

  if (parts.length === 0) return null;

  return (
    <div style={{ color: '#9ca3af', paddingLeft: '1.5rem' }}>
      {'  └ '}{parts.join(' | ')}
    </div>
  );
};

export const DeploymentLogs: React.FC<DeploymentLogsProps> = ({ deploymentId, autoScroll = true }) => {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;

    const fetchLogs = async () => {
      try {
        const res = await fetch(`${API_BASE}/deployments/${deploymentId}/history`);
        const data = await res.json();
        if (data.success && active) {
          setEntries(data.data);
        }
      } catch {
        // ignore
      }
    };

    fetchLogs();
    const timer = setInterval(fetchLogs, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [deploymentId]);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const steps = (meta: Record<string, unknown>) => meta.steps as DestroyStep[] | undefined;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <Terminal size={16} />
        <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>Deployment Logs</span>
      </div>
      <div
        ref={containerRef}
        style={{
          background: '#111827',
          color: '#e5e7eb',
          fontFamily: 'ui-monospace, monospace',
          fontSize: '0.75rem',
          padding: '1rem',
          borderRadius: '0.5rem',
          maxHeight: '400px',
          overflowY: 'auto',
          lineHeight: 1.8,
        }}
      >
        {entries.length === 0 ? (
          <span style={{ color: '#6b7280' }}>Waiting for logs...</span>
        ) : (
          entries.map((entry, i) => (
            <div key={i}>
              <div>
                <span style={{ color: '#6b7280' }}>[{new Date(entry.createdAt).toLocaleTimeString()}]</span>
                {' '}
                <span style={{ color: statusColor(entry.toStatus), fontWeight: 600 }}>{entry.toStatus}</span>
                {entry.fromStatus && entry.fromStatus !== entry.toStatus && (
                  <span style={{ color: '#6b7280' }}>{' ← '}{entry.fromStatus}</span>
                )}
                {entry.reason && <span>{': '}{entry.reason}</span>}
              </div>
              {entry.metadata && !steps(entry.metadata) && (
                <ProviderMetaLine meta={entry.metadata} />
              )}
              {entry.metadata && steps(entry.metadata) && (
                <div style={{ paddingLeft: '1.5rem' }}>
                  {steps(entry.metadata)!.map((step, j) => {
                    const icon = stepIcon(step.status);
                    return (
                      <div key={j} style={{ color: icon.color }}>
                        {icon.symbol} {step.resource}
                        {step.resourceId ? ` ${step.resourceId.substring(0, 16)}` : ''}
                        {' — '}{step.action}
                        {' — '}{step.detail || step.error || ''}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
