/**
 * audioMONASTRY · Worker-Factory (Plattform-Kapsel)
 * ==================================================
 * Zentrale Erzeugung von Web-Workern. Komponenten instanziieren Worker nicht
 * mehr direkt, sondern über diese Factory (Interface-Boundary-Regel 1.1,
 * IComputeBackend-Auslagerung).
 */

let visualizerWorker: Worker | null = null;

/** Liefert den (singleton) Visualizer-Worker oder erzeugt ihn lazy. */
export function createVisualizerWorker(): Worker {
  if (visualizerWorker) return visualizerWorker;
  visualizerWorker = new Worker(new URL('../workers/visualizerWorker.ts', import.meta.url), {
    type: 'module',
  });
  return visualizerWorker;
}

let beatDetectionWorker: Worker | null = null;

/** Liefert den (singleton) Beat-Detection-Worker oder erzeugt ihn lazy (AUDIO-P0-BEATMATCH-B1). */
export function createBeatDetectionWorker(): Worker {
  if (beatDetectionWorker) return beatDetectionWorker;
  beatDetectionWorker = new Worker(new URL('../audio/beat/BeatDetectionWorker.ts', import.meta.url), {
    type: 'module',
    name: 'beat-detection-worker',
  });
  return beatDetectionWorker;
}

/** Beendet den Beat-Detection-Worker (z. B. bei Hot-Reload/Unmount). */
export function disposeBeatDetectionWorker(): void {
  beatDetectionWorker?.terminate();
  beatDetectionWorker = null;
}

/** Beendet den Visualizer-Worker (z. B. bei Hot-Reload/Unmount). */
export function disposeVisualizerWorker(): void {
  visualizerWorker?.terminate();
  visualizerWorker = null;
}
