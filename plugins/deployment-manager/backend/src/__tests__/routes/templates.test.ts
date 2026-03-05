import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTemplatesRouter } from '../../routes/templates.js';

function createMockTemplateRegistry() {
  return {
    getTemplates: vi.fn(),
    getTemplate: vi.fn(),
    addCustomTemplate: vi.fn(),
    removeCustomTemplate: vi.fn(),
    getVersions: vi.fn(),
    getLatestVersion: vi.fn(),
  };
}

function createApp() {
  const mockRegistry = createMockTemplateRegistry();
  const app = express();
  app.use(express.json());
  app.use('/', createTemplatesRouter(mockRegistry as any));
  return { app, mockRegistry };
}

describe('Templates Router', () => {
  let app: express.Express;
  let mockRegistry: ReturnType<typeof createMockTemplateRegistry>;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ app, mockRegistry } = createApp());
  });

  describe('GET /', () => {
    it('returns template list', async () => {
      const templates = [
        { id: 'ai-runner', name: 'AI Runner', dockerImage: 'ai-runner:v1' },
        { id: 'comfyui', name: 'ComfyUI', dockerImage: 'comfyui:v1' },
      ];
      mockRegistry.getTemplates.mockReturnValue(templates);

      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(templates);
    });
  });

  describe('GET /:id', () => {
    it('returns 404 for unknown template', async () => {
      mockRegistry.getTemplate.mockReturnValue(undefined);

      const res = await request(app).get('/unknown');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Unknown template: unknown');
    });

    it('returns template when found', async () => {
      const template = { id: 'ai-runner', name: 'AI Runner', dockerImage: 'ai-runner:v1' };
      mockRegistry.getTemplate.mockReturnValue(template);

      const res = await request(app).get('/ai-runner');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(template);
    });
  });

  describe('GET /:id/versions', () => {
    it('returns versions', async () => {
      const versions = ['v1.0.0', 'v1.1.0', 'v2.0.0'];
      mockRegistry.getVersions.mockResolvedValue(versions);

      const res = await request(app).get('/ai-runner/versions');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(versions);
    });
  });

  describe('GET /:id/latest', () => {
    it('returns 404 when no releases found', async () => {
      mockRegistry.getLatestVersion.mockResolvedValue(undefined);

      const res = await request(app).get('/ai-runner/latest');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('No releases found');
    });

    it('returns latest version', async () => {
      mockRegistry.getLatestVersion.mockResolvedValue('v2.0.0');

      const res = await request(app).get('/ai-runner/latest');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBe('v2.0.0');
    });
  });

  describe('POST /', () => {
    it('creates custom template (201)', async () => {
      const body = {
        id: 'custom-1',
        name: 'Custom Template',
        dockerImage: 'custom:v1',
      };
      const created = { ...body, description: '', icon: '📦', healthEndpoint: '/health', healthPort: 8080 };
      mockRegistry.addCustomTemplate.mockReturnValue(created);

      const res = await request(app).post('/').send(body);
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(created);
    });

    it('returns 400 when missing required fields', async () => {
      const res = await request(app).post('/').send({ id: 'custom-1' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('id, name, and dockerImage are required');
    });

    it('returns 400 when name is missing', async () => {
      const res = await request(app)
        .post('/')
        .send({ id: 'custom-1', dockerImage: 'img:v1' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 when dockerImage is missing', async () => {
      const res = await request(app)
        .post('/')
        .send({ id: 'custom-1', name: 'Test' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('DELETE /:id', () => {
    it('returns 404 when template not found', async () => {
      mockRegistry.removeCustomTemplate.mockReturnValue(false);

      const res = await request(app).delete('/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Template not found or is a curated template');
    });

    it('removes custom template', async () => {
      mockRegistry.removeCustomTemplate.mockReturnValue(true);

      const res = await request(app).delete('/custom-1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
