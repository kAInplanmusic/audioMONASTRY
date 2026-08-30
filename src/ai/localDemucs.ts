/**
 * audioMONASTRY · Echte Demucs-ONNX-Stem-Separation (100% Modell-Inferenz)
 * =========================================================================
 * Lädt `htdemucs.onnx` (HTDemucs v4, 4 Stems: drums/bass/other/vocals) über
 * ONNX Runtime Web und führt die vollständige Inferenz aus:
 *
 *   decode → 44,1 kHz → Segmentierung (343.980 Samples, 25% Overlap)
 *   → Inference (WebGPU, Fallback WASM) → Overlap-Add mit linearem Fenster
 *   → WAV-Encode
 *
 * Kein pseudo-Fallback im Modell-Pfad. Der DSP-Split (`stemSplitter.ts`)
 * bleibt ausschließlich als Notfall erhalten, wenn das Modell nicht geladen
 * werden kann (z. B. offline installierte Instanz).
 */
export const DEMUCS_MODEL_URL = '/models/htdemucs.onnx';
export const DEMUCS_SEGMENT = 343980; // ~7,8 s @ 44,1 kHz
export const DEMUCS_OVERLAP = 0.25;

export interface DemucsStems {
  drums: string;
  bass: string;
  other: string;
  vocals: string;
}

type Ort = typeof import('onnxruntime-web');

let ortPromise: Promise<Ort> | null = null;

function getOrt(): Promise<Ort> {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web') as unknown as Promise<Ort>;
  }
  return ortPromise;
}

/** AudioBuffer → 16-Bit-PCM-WAV-Blob (Stereo). */
function encodeWav(buffer: Float32Array[], sampleRate: number): Blob {
  const numCh = Math.min(2, buffer.length);
  const len = buffer[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, buffer[ch][i] || 0));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Linearer Overlap-Add-Fenster-Anteil für Position `i` im Segment. */
function windowWeight(i: number, segLen: number, ramp: number): number {
  if (i < ramp) return i / ramp;
  if (i >= segLen - ramp) return (segLen - i) / ramp;
  return 1;
}

/**
 * Führt die vollständige HTDemucs-Inferenz auf einer Audio-Datei aus.
 * Liefert Object-URLs für drums/bass/other/vocals.
 */
export async function separateStemsWithDemucs( // NOSONAR: bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring wuerde Risiko erhoehen
  file: File,
  onProgress?: (p: number) => void,
): Promise<DemucsStems> {
  const ort = await getOrt();

  // --- WASM-Threading: mit COOP/COEP (crossOriginIsolated) mehr Threads nutzen ---
  try {
    const wasm = (ort as unknown as { env?: { wasm?: { numThreads?: number; simd?: boolean; proxy?: boolean } } }).env?.wasm;
    if (wasm) {
      const isolated = (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
      const cores = (globalThis as unknown as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 2;
      wasm.numThreads = isolated ? Math.max(1, Math.min(4, cores)) : 1;
      wasm.simd = true;
      wasm.proxy = true;
    }
  } catch { /* Threading-Konfiguration optional */ }

  // --- Session (WebGPU bevorzugt, WASM-Fallback) ---
  let session: Awaited<ReturnType<Ort["InferenceSession"]["create"]>>;
  try {
    session = await ort.InferenceSession.create(DEMUCS_MODEL_URL, {
      executionProviders: ['webgpu', 'wasm'],
      graphOptimizationLevel: 'all',
    });
  } catch {
    session = await ort.InferenceSession.create(DEMUCS_MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }
  onProgress?.(5);

  // --- Decode + Resample auf 44,1 kHz ---
  const OfflineCtx = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext });
  const Ctx = OfflineCtx.OfflineAudioContext ?? OfflineCtx.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('OfflineAudioContext nicht verfügbar');

  const ab = await file.arrayBuffer();
  const decodeCtx = new Ctx(2, 1, 44100);
  const decoded = await decodeCtx.decodeAudioData(ab);
  const total = Math.ceil(decoded.duration * 44100);
  const renderCtx = new Ctx(2, total, 44100);
  const src = renderCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(renderCtx.destination);
  src.start(0);
  const audio = await renderCtx.startRendering();
  onProgress?.(15);

  const chL = audio.getChannelData(0);
  const chR = audio.numberOfChannels > 1 ? audio.getChannelData(1) : audio.getChannelData(0);

  // --- Segmentierung + Overlap-Add ---
  const seg = DEMUCS_SEGMENT;
  const ramp = Math.round(seg * DEMUCS_OVERLAP);
  const hop = seg - ramp;
  const nChunks = Math.max(1, Math.ceil((total - ramp) / hop));
  const stems = [0, 1, 2, 3].map(() => [new Float32Array(total), new Float32Array(total)]);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  for (let c = 0; c < nChunks; c++) {
    const offset = c * hop;
    const segData = new Float32Array(2 * seg); // interleaved L/R
    for (let i = 0; i < seg; i++) {
      const idx = Math.min(offset + i, total - 1);
      segData[i * 2] = chL[idx];
      segData[i * 2 + 1] = chR[idx];
    }

    const inputTensor = new ort.Tensor('float32', segData, [1, 2, seg]);
    const feeds: Record<string, unknown> = { [inputName]: inputTensor };
    const results = await session.run(feeds as never);
    const out = results[outputName];
    const outData = out.data as Float32Array; // [1, S, 2, seg]
    const S = out.dims[1] ?? 4;

    for (let s = 0; s < Math.min(S, 4); s++) {
      for (let ch = 0; ch < 2; ch++) {
        const stem = stems[s][ch];
        for (let i = 0; i < seg; i++) {
          const srcIdx = offset + i;
          if (srcIdx >= total) break;
          const v = outData[((s * 2 + ch) * seg) + i];
          const w = windowWeight(i, seg, ramp);
          stem[srcIdx] += (Number.isFinite(v) ? v : 0) * w;
        }
      }
    }
    onProgress?.(15 + Math.round(80 * ((c + 1) / nChunks)));
  }

  // --- WAV-Encode pro Stem ---
  const names: (keyof DemucsStems)[] = ['drums', 'bass', 'other', 'vocals'];
  const out: Partial<DemucsStems> = {};
  names.forEach((name, s) => {
    if (!stems[s]) return;
    out[name] = URL.createObjectURL(encodeWav(stems[s], 44100));
  });
  onProgress?.(100);

  return {
    drums: out.drums ?? '',
    bass: out.bass ?? '',
    other: out.other ?? '',
    vocals: out.vocals ?? '',
  };
}
