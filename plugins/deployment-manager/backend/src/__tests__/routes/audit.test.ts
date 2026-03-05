import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuditRouter } from '../../routes/audit.js';

function createMockAuditService() {
  return {
    query: vi.fn(),
  };
}

function createApp() {
  const mockAudit = createMockAuditService();
  const app = express();
  app.use(express.json());
  app.use('/', createAuditRouter(mockAudit as any));
  return { app, mockAudit };
}

describe('Audit Router', () => {
  let app: express.Express;
  let mockAudit: ReturnType<typeof createMockAuditService>;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ app, mockAudit } = createApp());
  });

  describe('GET /', () => {
    it('returns paginated audit logs', async () => {
      const entries = [
        { id: 'a1', action: 'CREATE', userId: 'u1', createdAt: '2025-01-01T00:00:00Z' },
        { id: 'a2', action: 'DEPLOY', userId: 'u2', createdAt: '2025-01-01T01:00:00Z' },
      ];
      mockAudit.query.mockResolvedValue({ data: entries, total: 2 });

      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(entries);
      expect(res.body.total).toBe(2);
    });

    it('passes filter query params', async () => {
      mockAudit.query.mockResolvedValue({ data: [], total: 0 });

      await request(app).get('/?deploymentId=dep-1&userId=user-1&action=DEPLOY&limit=10&offset=5');
      expect(mockAudit.query).toHaveBeenCalledWith({
        deploymentId: 'dep-1',
        userId: 'user-1',
        action: 'DEPLOY',
        limit: 10,
        offset: 5,
      });
    });

    it('uses default limit=50, offset=0 when not specified', async () => {
      mockAudit.query.mockResolvedValue({ data: [], total: 0 });

      await request(app).get('/');
      expect(mockAudit.query).toHaveBeenCalledWith({
        deploymentId: undefined,
        userId: undefined,
        action: undefined,
        limit: 50,
        offset: 0,
      });
    });

    it('returns 500 on service error', async () => {
      mockAudit.query.mockRejectedValue(new Error('DB connection failed'));

      const res = await request(app).get('/');
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('DB connection failed');
    });
  });
});
