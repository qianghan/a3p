import { Router } from 'express';
import type { CostEstimationService } from '../services/CostEstimationService.js';

export function createCostRouter(costService: CostEstimationService): Router {
  const router = Router();

  router.get('/estimate', async (req, res) => {
    try {
      const { provider, gpu, count } = req.query;
      if (!provider || !gpu) {
        res.status(400).json({ success: false, error: 'provider and gpu query params required' });
        return;
      }
      const gpuCount = parseInt(count as string, 10) || 1;
      const estimate = await costService.estimate(provider as string, gpu as string, gpuCount);
      res.json({ success: true, data: estimate });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
