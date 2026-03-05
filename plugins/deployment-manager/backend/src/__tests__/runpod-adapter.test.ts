import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RunPodAdapter } from '../adapters/RunPodAdapter.js';
import type { DeployConfig, UpdateConfig } from '../types/index.js';

const GATEWAY_BASE = process.env.SHELL_URL || 'http://localhost:3000';
const GW_PREFIX = `${GATEWAY_BASE}/api/v1/gw/runpod-serverless`;

describe('RunPodAdapter', () => {
  let adapter: RunPodAdapter;
  const mockFetch = vi.fn();

  beforeEach(() => {
    adapter = new RunPodAdapter();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct metadata', () => {
    expect(adapter.slug).toBe('runpod');
    expect(adapter.connectorSlug).toBe('runpod-serverless');
    expect(adapter.mode).toBe('serverless');
  });

  describe('getGpuOptions', () => {
    it('returns mapped GPU options from API on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ([
          { id: 'gpu-a100', displayName: 'A100 80GB', memoryInGb: 80, available: true, securePrice: 3.5 },
          { id: 'gpu-t4', displayName: 'T4 16GB', memoryInGb: 16, available: false, communityPrice: 0.5 },
        ]),
        text: async () => '',
      } as any);

      const options = await adapter.getGpuOptions();
      expect(options).toHaveLength(2);
      expect(options[0]).toMatchObject({ id: 'gpu-a100', name: 'A100 80GB', vramGb: 80, available: true, pricePerHour: 3.5 });
      expect(options[1]).toMatchObject({ id: 'gpu-t4', available: false, pricePerHour: 0.5 });
    });

    it('falls back to static options when API returns non-array', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ error: 'unexpected' }),
        text: async () => '',
      } as any);

      const options = await adapter.getGpuOptions();
      expect(options.length).toBeGreaterThan(0);
      expect(options[0].id).toBe('NVIDIA A100 80GB');
    });

    it('falls back to static options on fetch failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const options = await adapter.getGpuOptions();
      expect(options.length).toBeGreaterThan(0);
      expect(options[0].id).toBe('NVIDIA A100 80GB');
    });

    it('falls back to static options on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => '',
      } as any);

      const options = await adapter.getGpuOptions();
      expect(options.length).toBeGreaterThan(0);
      expect(options[0].id).toBe('NVIDIA A100 80GB');
    });
  });

  describe('deploy', () => {
    const config: DeployConfig = {
      name: 'test-endpoint',
      providerSlug: 'runpod',
      gpuModel: 'NVIDIA A100 80GB',
      gpuVramGb: 80,
      gpuCount: 1,
      artifactType: 'ai-runner',
      artifactVersion: 'v1.0',
      dockerImage: 'my-org/my-image:latest',
      artifactConfig: { MODEL_ID: 'test' },
    };

    it('returns providerDeploymentId on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'ep-abc123' }),
        text: async () => '',
      } as any);

      const result = await adapter.deploy(config);
      expect(result.providerDeploymentId).toBe('ep-abc123');
      expect(result.endpointUrl).toBe('https://api.runpod.ai/v2/ep-abc123');
      expect(result.status).toBe('DEPLOYING');

      expect(mockFetch).toHaveBeenCalledWith(
        `${GW_PREFIX}/endpoints`,
        expect.objectContaining({ method: 'POST' }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.name).toBe('test-endpoint');
      expect(body.dockerImage).toBe('my-org/my-image:latest');
      expect(body.gpuTypeId).toBe('NVIDIA A100 80GB');
      expect(body.env).toEqual({ MODEL_ID: 'test' });
    });

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({}),
        text: async () => 'Validation error',
      } as any);

      await expect(adapter.deploy(config)).rejects.toThrow('RunPod deploy failed (422): Validation error');
    });
  });

  describe('getStatus', () => {
    it('maps READY to ONLINE', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'READY' }),
        text: async () => '',
      } as any);

      const result = await adapter.getStatus('ep-abc123');
      expect(result.status).toBe('ONLINE');
      expect(result.endpointUrl).toBe('https://api.runpod.ai/v2/ep-abc123');
    });

    it('maps INITIALIZING to DEPLOYING', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'INITIALIZING' }),
        text: async () => '',
      } as any);

      const result = await adapter.getStatus('ep-abc123');
      expect(result.status).toBe('DEPLOYING');
    });

    it('maps UNHEALTHY to ONLINE', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'UNHEALTHY' }),
        text: async () => '',
      } as any);

      const result = await adapter.getStatus('ep-abc123');
      expect(result.status).toBe('ONLINE');
    });

    it('maps OFFLINE to FAILED', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'OFFLINE' }),
        text: async () => '',
      } as any);

      const result = await adapter.getStatus('ep-abc123');
      expect(result.status).toBe('FAILED');
    });

    it('returns FAILED when response is not ok', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => '',
      } as any);

      const result = await adapter.getStatus('ep-abc123');
      expect(result.status).toBe('FAILED');
    });
  });

  describe('destroy', () => {
    it('calls DELETE on the endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '',
      } as any);

      await adapter.destroy('ep-abc123');
      expect(mockFetch).toHaveBeenCalledWith(
        `${GW_PREFIX}/endpoints/ep-abc123`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('does not throw on 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => 'Not Found',
      } as any);

      await expect(adapter.destroy('ep-abc123')).resolves.toBeUndefined();
    });

    it('throws on non-404 error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => 'Server Error',
      } as any);

      await expect(adapter.destroy('ep-abc123')).rejects.toThrow('RunPod destroy failed (500)');
    });
  });

  describe('update', () => {
    it('sends PUT with updated fields', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'ep-abc123' }),
        text: async () => '',
      } as any);

      const updateConfig: UpdateConfig = {
        dockerImage: 'my-org/new-image:v2',
        gpuModel: 'NVIDIA H100 80GB',
        gpuCount: 2,
      };
      const result = await adapter.update('ep-abc123', updateConfig);

      expect(result.providerDeploymentId).toBe('ep-abc123');
      expect(result.status).toBe('UPDATING');
      expect(result.endpointUrl).toBe('https://api.runpod.ai/v2/ep-abc123');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.dockerImage).toBe('my-org/new-image:v2');
      expect(body.gpuTypeId).toBe('NVIDIA H100 80GB');
      expect(body.gpuCount).toBe(2);
    });

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({}),
        text: async () => 'Bad Request',
      } as any);

      await expect(adapter.update('ep-abc123', {})).rejects.toThrow('RunPod update failed (400)');
    });
  });

  describe('healthCheck', () => {
    it('returns GREEN when status is READY', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'READY', workers: { running: 1 } }),
        text: async () => '',
      } as any);

      const result = await adapter.healthCheck('ep-abc123');
      expect(result.healthy).toBe(true);
      expect(result.status).toBe('GREEN');
      expect(result.statusCode).toBe(200);
    });

    it('returns GREEN when workers are running', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'SOMETHING', workers: { running: 2 } }),
        text: async () => '',
      } as any);

      const result = await adapter.healthCheck('ep-abc123');
      expect(result.healthy).toBe(true);
      expect(result.status).toBe('GREEN');
    });

    it('returns RED when not ready and no workers running', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'OFFLINE', workers: { running: 0 } }),
        text: async () => '',
      } as any);

      const result = await adapter.healthCheck('ep-abc123');
      expect(result.healthy).toBe(false);
      expect(result.status).toBe('RED');
    });

    it('returns RED when response is not ok', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({}),
        text: async () => '',
      } as any);

      const result = await adapter.healthCheck('ep-abc123');
      expect(result.healthy).toBe(false);
      expect(result.status).toBe('RED');
      expect(result.statusCode).toBe(503);
    });

    it('returns RED when fetch throws', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await adapter.healthCheck('ep-abc123');
      expect(result.healthy).toBe(false);
      expect(result.status).toBe('RED');
    });

    it('calls the correct health endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'READY' }),
        text: async () => '',
      } as any);

      await adapter.healthCheck('ep-abc123');
      expect(mockFetch).toHaveBeenCalledWith(
        `${GW_PREFIX}/endpoints/ep-abc123/health`,
        expect.any(Object),
      );
    });
  });
});
