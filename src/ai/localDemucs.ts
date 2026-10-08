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
import { encodeWavFromChannels } from '../utils/wavEncode';
import { DemucsOlaAccumulator } from './demucsOla';

const DEMUCS_MODEL_URL = '/models/htdemucs.onnx';
const DEMUCS_SEGMENT = 343980; // ~7,8 s @ 44,1 kHz
const DEMUCS_OVERLAP = 0.25;

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
      // Proxy-Worker nur bei COOP/COEP aktivieren. Ohne crossOriginIsolated
      // erzeugt onnxruntime im Vite-Dev-Bundle einen Blob-Worker mit
      // `export`-Token → „Unexpected token 'export'“ (Page-Error).
      wasm.proxy = isolated;
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
  // RT-AUDIT-P2-018: Overlap-Add mit Randregel + Gewichtsnormierung (src/ai/demucsOla.ts).
  const nChunks = DemucsOlaAccumulator.chunkCount(total, seg, ramp);
  const ola = new DemucsOlaAccumulator(total, seg, ramp, 4, 2);
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
    ola.add(offset, outData, S, c === 0, c === nChunks - 1);
    onProgress?.(15 + Math.round(80 * ((c + 1) / nChunks)));
  }
  const stems = ola.finalize();

  // --- WAV-Encode pro Stem ---
  const names: (keyof DemucsStems)[] = ['drums', 'bass', 'other', 'vocals'];
  const out: Partial<DemucsStems> = {};
  names.forEach((name, s) => {
    if (!stems[s]) return;
    out[name] = URL.createObjectURL(encodeWavFromChannels(stems[s], 44100));
  });
  onProgress?.(100);

  return {
    drums: out.drums ?? '',
    bass: out.bass ?? '',
    other: out.other ?? '',
    vocals: out.vocals ?? '',
  };
}
