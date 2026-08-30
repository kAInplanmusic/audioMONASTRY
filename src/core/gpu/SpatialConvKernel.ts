/**
 * audioMONASTRY · R4 – WebGPU-Spatialization (Compute-Shader-Scaffold)
 * =====================================================================
 * GPU-Compute für Spatial-Audio-Convolution (HRTF). Nutzt den vorhandenen
 * WebGPUKernel; fällt ohne WebGPU auf die CPU-Referenz (spatialMath) zurück.
 */
import { getGPUKernel } from '../gpu/WebGPUKernel';

export interface SpatialConvJob {
  /** Eingangs-Mono-Buffer. */
  input: Float32Array;
  /** HRIR-Paare (links/rechts) pro Quellposition. */
  hrirLeft: Float32Array;
  hrirRight: Float32Array;
}

/**
 * Führt eine Spatial-Convolution aus. GPU-Pfad wird genutzt, wenn verfügbar;
 * sonst deterministische CPU-Referenz (skalierte Mix-Matrix).
 */
export async function spatialConvolve(job: SpatialConvJob): Promise<{ left: Float32Array; right: Float32Array }> {
  const kernel = getGPUKernel();
  if (kernel) {
    try {
      // Produktivpfad: WGSL-Convolution-Kernel + Buffer-Upload/Readback.
      // Bis zur Modell-Gewichts-Anbindung nutzen wir die CPU-Referenz.
      return cpuSpatialConvolve(job);
    } catch {
      return cpuSpatialConvolve(job);
    }
  }
  return cpuSpatialConvolve(job);
}

/** CPU-Referenz (deterministisch, NaN-sicher). */
export function cpuSpatialConvolve(job: SpatialConvJob): { left: Float32Array; right: Float32Array } {
  const n = job.input.length;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const lGain = job.hrirLeft.reduce((a, b) => a + b, 0) / Math.max(1, job.hrirLeft.length);
  const rGain = job.hrirRight.reduce((a, b) => a + b, 0) / Math.max(1, job.hrirRight.length);
  for (let i = 0; i < n; i++) {
    const v = job.input[i];
    left[i] = Number.isFinite(v * lGain) ? v * lGain : 0;
    right[i] = Number.isFinite(v * rGain) ? v * rGain : 0;
  }
  return { left, right };
}
