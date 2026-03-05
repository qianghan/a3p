import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHealthRouter } from '../../routes/health.js';

function createMockHealthMonitor() {
  return {
    getHealthLogs: vi.fn(),
    checkById: vi.fn(),
  };
}

function createMockOrchestrator() {
  return {
    list: vi.fn(),
  };
}

function createApp() {
  const mockHealthMonitor = createMockHealthMonitor();
  const mockOrchestrator = createMockOrchestrator();
  const app = express();
  app.use(express.json());
  app.use('/', createHealthRouter(mockHealthMonitor as any, mockOrchestrator as any));
  return { app, mockHealthMonitor, mockOrchestrator };
}

describe('Health Router', () => {
  let app: express.Express;
  let mockHealthMonitor: ReturnType<typeof createMockHealthMonitor>;
  let mockOrchestrator: ReturnType<typeof createMockOrchestrator>;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ app, mockHealthMonitor, mockOrchestrator } = createApp());
  });

  describe('GET /summary', () => {
    it('returns health counts', async () => {
      mockOrchestrator.list.mockResolvedValue([
        { id: 'd1', healthStatus: 'GREEN' },
        { id: 'd2', healthStatus: 'GREEN' },
        { id: 'd3', healthStatus: 'RED' },
        { id: 'd4', healthStatus: 'ORANGE' },
        { id: 'd5', healthStatus: 'UNKNOWN' },
      ]);

      const res = await request(app).get('/summary');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
        total: 5,
        green: 2,
        orange: 1,
        red: 1,
        unknown: 1,
      });
    });

    it('returns zeroes when no deployments exist', async () => {
      mockOrchestrator.list.mockResolvedValue([]);

      const res = await request(app).get('/summary');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        total: 0,
        green: 0,
        orange: 0,
        red: 0,
        unknown: 0,
      });
    });
  });

  describe('GET /:deploymentId', () => {
    it('returns health logs', async () => {
      const logs = [
        { status: 'GREEN', checkedAt: '2025-01-01T00:00:00Z' },
        { status: 'RED', checkedAt: '2025-01-01T00:01:00Z' },
      ];
      mockHealthMonitor.getHealthLogs.mockReturnValue(logs);

      const res = await request(app).get('/dep-1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(logs);
      expect(mockHealthMonitor.getHealthLogs).toHaveBeenCalledWith('dep-1', 50);
    });

    it('passes custom limit query param', async () => {
      mockHealthMonitor.getHealthLogs.mockReturnValue([]);

      await request(app).get('/dep-1?limit=10');
      expect(mockHealthMonitor.getHealthLogs).toHaveBeenCalledWith('dep-1', 10);
    });
  });

  describe('POST /:deploymentId/check', () => {
    it('returns check result', async () => {
      const result = { status: 'GREEN', latencyMs: 42 };
      mockHealthMonitor.checkById.mockResolvedValue(result);

      const res = await request(app).post('/dep-1/check');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(result);
    });

    it('returns 404 when deployment not found', async () => {
      mockHealthMonitor.checkById.mockResolvedValue(undefined);

      const res = await request(app).post('/nonexistent/check');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Deployment not found');
    });
  });
});
