import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCostRouter } from '../../routes/cost.js';

describe('Cost Router', () => {
  let app: express.Express;
  const mockEstimate = vi.fn();

  beforeEach(() => {
    mockEstimate.mockReset();
    app = express();
    app.use(express.json());
    app.use('/cost', createCostRouter({ estimate: mockEstimate } as any));
  });

  it('GET /estimate returns cost estimate', async () => {
    mockEstimate.mockResolvedValueOnce({
      gpuCostPerHour: 2.55,
      totalCostPerHour: 2.65,
      totalCostPerDay: 63.6,
      totalCostPerMonth: 1908,
      currency: 'USD',
      breakdown: { gpu: 2.55, storage: 0.10, network: 0 },
      providerSlug: 'fal-ai',
      gpuModel: 'A100',
      gpuCount: 1,
    });

    const res = await request(app).get('/cost/estimate?provider=fal-ai&gpu=A100&count=1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.gpuCostPerHour).toBe(2.55);
    expect(res.body.data.providerSlug).toBe('fal-ai');
  });

  it('GET /estimate returns 400 when provider is missing', async () => {
    const res = await request(app).get('/cost/estimate?gpu=A100');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('provider');
  });

  it('GET /estimate returns 400 when gpu is missing', async () => {
    const res = await request(app).get('/cost/estimate?provider=fal-ai');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('gpu');
  });

  it('GET /estimate returns 400 when both params are missing', async () => {
    const res = await request(app).get('/cost/estimate');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('GET /estimate defaults count to 1', async () => {
    mockEstimate.mockResolvedValueOnce({
      gpuCostPerHour: 1.0,
      totalCostPerHour: 1.1,
      totalCostPerDay: 26.4,
      totalCostPerMonth: 792,
      currency: 'USD',
      breakdown: { gpu: 1.0, storage: 0.10, network: 0 },
      providerSlug: 'test',
      gpuModel: 'A100',
      gpuCount: 1,
    });

    await request(app).get('/cost/estimate?provider=test&gpu=A100');
    expect(mockEstimate).toHaveBeenCalledWith('test', 'A100', 1);
  });

  it('GET /estimate parses numeric count', async () => {
    mockEstimate.mockResolvedValueOnce({
      gpuCostPerHour: 2.0,
      totalCostPerHour: 4.1,
      totalCostPerDay: 98.4,
      totalCostPerMonth: 2952,
      currency: 'USD',
      breakdown: { gpu: 4.0, storage: 0.10, network: 0 },
      providerSlug: 'test',
      gpuModel: 'A100',
      gpuCount: 2,
    });

    await request(app).get('/cost/estimate?provider=test&gpu=A100&count=2');
    expect(mockEstimate).toHaveBeenCalledWith('test', 'A100', 2);
  });

  it('GET /estimate handles service errors', async () => {
    mockEstimate.mockRejectedValueOnce(new Error('Provider unavailable'));
    const res = await request(app).get('/cost/estimate?provider=bad&gpu=X');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Provider unavailable');
  });
});
