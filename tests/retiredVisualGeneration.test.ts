// @vitest-environment node
import type { Express } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAiRoutes } from '../server/routes/aiRoutes';
import { ProviderRouter } from '../src/core/ai/orchestrator/providerRouter';
import { saveArtifact } from '../server/visionArtifacts';

vi.mock('../server/visionArtifacts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../server/visionArtifacts')>(), saveArtifact: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

describe('retired FLUX/Wan routes cannot submit or persist generated media', () => {
  it.each(['/api/ai/vision', '/api/ai/vision/video', '/api/ai/vision/clip'])('%s returns explicit 410', async (path) => {
    const routes = new Map<string, (...args: any[]) => unknown>();
    const app = { get: vi.fn(), post: (route: string, handler: (...args: any[]) => unknown) => routes.set(route, handler) };
    registerAiRoutes(app as unknown as Express, { metrics: { aiRequests: 0, aiFailures: 0, aiCacheHits: 0, aiCacheMisses: 0 } });
    const run = vi.spyOn(ProviderRouter.prototype, 'run');
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    await routes.get(path)!({ body: { prompt: 'old generator request' } }, res);
    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VISUAL_GENERATION_RETIRED' }));
    expect(run).not.toHaveBeenCalled();
    expect(saveArtifact).not.toHaveBeenCalled();
  });
});
