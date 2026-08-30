/**
 * audioMONASTRY · Phase 5 – Offline Render Engine
 * ================================================
 * Deterministisches Rendering. Nutzt exakt dieselbe AudioGraph-Struktur wie
 * die Realtime-Pipeline; Render-Faktor steuert Zeit-/Speichertradeoff.
 */
import type { IAudioBuffer, IAudioGraph, IProcessingContext } from '../audio/types';

export type RenderFactor = 1 | 4 | 20;

export interface OfflineRenderRequest {
  graph: IAudioGraph;
  sampleRate: number;
  durationSeconds: number;
  channels: number;
  factor: RenderFactor;
}

export interface OfflineRenderResult {
  buffer: IAudioBuffer;
  elapsedMs: number;
  factor: RenderFactor;
  deterministic: true;
}

export class OfflineRenderer {
  async render(req: OfflineRenderRequest, output: IAudioBuffer): Promise<OfflineRenderResult> {
    const started = Date.now();
    const bufferSize = 128 * req.factor;
    const frames = Math.ceil(req.sampleRate * req.durationSeconds);
    const ctx: IProcessingContext = {
      sampleRate: req.sampleRate,
      bufferSize,
      quantum: bufferSize / req.sampleRate,
      currentTime: 0,
    };

    // Gleiche Graph-Struktur wie Realtime: kompilieren und pro Block verarbeiten.
    for (let offset = 0; offset < frames; offset += bufferSize) {
      ctx.currentTime = offset / req.sampleRate;
      req.graph.process(ctx);
      const last = req.graph.getLastOutput();
      for (let ch = 0; ch < output.numberOfChannels; ch++) {
        const src = last?.[ch] ?? last?.[0];
        if (src) {
          output.channelData[ch].set(src.subarray(0, Math.min(src.length, Math.min(frames, offset + bufferSize) - offset)), offset);
        } else {
          output.channelData[ch].fill(0, offset, Math.min(frames, offset + bufferSize));
        }
      }
    }

    return {
      buffer: output,
      elapsedMs: Date.now() - started,
      factor: req.factor,
      deterministic: true,
    };
  }
}
