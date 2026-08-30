/**
 * audioMONASTRY · Phase 5 – Offline Render Queue
 * ==============================================
 * Reiht deterministische Offline-Render-Jobs (Faktoren 1x/4x/20x) und
 * verarbeitet sie sequenziell. Nutzt dieselbe AudioGraph-Struktur wie Realtime.
 */
import { OfflineRenderer, type OfflineRenderRequest, type OfflineRenderResult, type RenderFactor } from './OfflineRenderer';
import type { IAudioBuffer } from '../audio/types';

export type RenderJobStatus = 'queued' | 'running' | 'done' | 'error';

export interface RenderJob {
  id: string;
  request: OfflineRenderRequest;
  output: IAudioBuffer;
  priority: number;
  status: RenderJobStatus;
  result?: OfflineRenderResult;
  error?: string;
}

export class OfflineRenderQueue {
  private jobs: RenderJob[] = [];
  private jobCounter = 0;

  enqueue(request: OfflineRenderRequest, output: IAudioBuffer, priority = 0): RenderJob {
    this.jobCounter += 1;
    const job: RenderJob = {
      // Deterministische, kollisionsfreie Job-ID ohne Math.random (Sonar S2245).
      id: `render-${Date.now().toString(36)}-${this.jobCounter.toString(36)}`,
      request,
      output,
      priority,
      status: 'queued',
    };
    this.jobs.push(job);
    this.jobs.sort((a, b) => b.priority - a.priority);
    return job;
  }

  list(): RenderJob[] {
    return [...this.jobs];
  }

  cancel(id: string): boolean {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.status !== 'queued') return false;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    return true;
  }

  async processAll(renderer: OfflineRenderer = new OfflineRenderer()): Promise<RenderJob[]> {
    for (const job of this.jobs) {
      if (job.status === 'done' || job.status === 'running') continue;
      job.status = 'running';
      try {
        job.result = await renderer.render(job.request, job.output);
        job.status = 'done';
      } catch (error) {
        job.status = 'error';
        job.error = error instanceof Error ? error.message : String(error);
      }
    }
    return this.list();
  }
}

export const RENDER_FACTORS: RenderFactor[] = [1, 4, 20];
