/**
 * audioMONASTRY · Worklet-Module laden (Single-Flight)
 * =====================================================================
 * WARUM DIESES MODUL EXISTIERT (Befund 2026-09-18, gemessen):
 * Das Laden lag vorher als lokale Funktion in `src/context/AudioContext.tsx`
 * und lief erst in `startAudio()`. Der Graph der AudioEngine baut seine
 * Worklet-Knoten aber in `audioEngine.init()` - und zwar OHNE auf das Laden zu
 * warten. Folge im Produktions-Build (gemessen im Chromium, lokaler Build):
 * fuenf der zehn DSP-Knoten fanden ihre module-Registrierung noch nicht und
 * fielen dauerhaft auf einen neutralen Gain-Knoten zurueck:
 *
 *   AudioWorklet 'dynamics-processor' nicht verfuegbar - nutze neutralen Gain-Fallback.
 *   AudioWorklet 'granular-processor' ...  'fm6-processor' ...
 *   AudioWorklet 'drumsynth-processor' ... 'lufs-processor' ...
 *
 * Das ist kein kosmetisches Problem: Dynamics, Granular, FM6, Drumsynth und die
 * LUFS-Messung liefen in dieser Sitzung als Pass-through. Deshalb liegt das Laden
 * jetzt hier, wird EINMAL ausgefuehrt (Single-Flight) und BEIDE Seiten warten
 * darauf: die React-Startkette und `audioEngine.init()`.
 *
 * Abhaengigkeiten werden injiziert (`ctx`, `fetchImpl`), damit das Verhalten ohne
 * Browser testbar ist - der Rest der Datei ist bewusst DOM-frei und hat KEINE
 * Seiteneffekte beim Import.
 *
 * HINWEIS (gemessen): der Aufruf muss ueber einen STATISCHEN Import erfolgen.
 * Ein dynamisches `await import(...)` innerhalb von `audioEngine.init()` liess in
 * der vitest-Umgebung einen anderen Test derselben Datei scheitern
 * (tests/audioEngine.test.ts: "V2-Session-State export/import round-trip",
 * importV2SessionState -> false), weil der Modulgraph zur Laufzeit neu ausgewertet
 * wurde. Statisch importiert ist alles gruen.
 */

export interface WorkletManifestEntry {
  id: string;
  url: string;
  hash?: string;
}

export interface WorkletLoadResult {
  /** Erfolgreich registrierte module-Registrierungen. */
  loaded: string[];
  /** Prozessoren, fuer die ein Dummy registriert wurde (echter Ausfall). */
  fallback: string[];
  /** Grund, falls das Manifest gar nicht gelesen werden konnte. */
  manifestError?: string;
}

interface WorkletContext {
  audioWorklet?: { addModule: (url: string) => Promise<unknown> };
}

export interface LoadWorkletsOptions {
  ctx: WorkletContext | null | undefined;
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;
  manifestUrl?: string;
}

/** Kandidaten-URLs: `/public/x` und `/x` (historisch beide im Umlauf). */
export function normalizeWorkletUrls(url: string): string[] {
  const normalized = url.startsWith('/public/') ? url.replace('/public/', '/') : url;
  return Array.from(new Set([url, normalized]));
}

/** Manifest lesen - tolerant, weil ein fehlendes Manifest kein Audiofehler ist. */
export async function readWorkletManifest(
  fetchImpl: LoadWorkletsOptions['fetchImpl'],
  manifestUrl: string,
): Promise<{ entries: WorkletManifestEntry[]; error?: string }> {
  if (!fetchImpl) return { entries: [], error: 'kein fetch verfuegbar' };
  try {
    const response = await fetchImpl(manifestUrl);
    if (!response.ok) return { entries: [], error: `HTTP ${response.status ?? '?'}` };
    const data = (await response.json()) as { worklets?: WorkletManifestEntry[] };
    return { entries: Array.isArray(data?.worklets) ? data.worklets : [] };
  } catch (err) {
    return { entries: [], error: (err as Error).message };
  }
}

/**
 * Laedt alle Manifest-Worklets. Bei einem Ausfall wird - wie bisher - ein
 * Durchreich-Dummy unter demselben Prozessornamen registriert, damit die
 * Audio-Kette nicht hart bricht.
 */
export async function loadWorkletsOnce(options: LoadWorkletsOptions): Promise<WorkletLoadResult> {
  const { ctx } = options;
  const fetchImpl = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  const manifestUrl = options.manifestUrl ?? '/plugin-manifest.json';
  const addModule = ctx?.audioWorklet?.addModule;
  if (typeof addModule !== 'function') {
    return { loaded: [], fallback: [], manifestError: 'kein audioWorklet.addModule' };
  }

  const { entries, error } = await readWorkletManifest(fetchImpl, manifestUrl);
  if (error) return { loaded: [], fallback: [], manifestError: error };

  const loaded: string[] = [];
  const fallback: string[] = [];
  for (const entry of entries) {
    let ok = false;
    for (const candidate of normalizeWorkletUrls(String(entry.url ?? ''))) {
      try {
        await addModule.call(ctx?.audioWorklet, candidate);
        ok = true;
        break;
      } catch {
        // naechste Kandidaten-URL versuchen
      }
    }
    if (ok) {
      loaded.push(entry.id);
      continue;
    }
    // Dummy als Pass-through registrieren (Verhalten wie bisher).
    const code = `class DummyProcessor extends AudioWorkletProcessor {
      process(inputs, outputs) {
        const input = inputs[0]; const output = outputs[0];
        if (!input || !input[0]) return true;
        for (let channel = 0; channel < input.length; ++channel) output[channel].set(input[channel]);
        return true;
      }
    }
    registerProcessor('${entry.id}', DummyProcessor);`;
    try {
      const blobUrl = `data:application/javascript,${encodeURIComponent(code)}`;
      await addModule.call(ctx?.audioWorklet, blobUrl);
      fallback.push(entry.id);
    } catch {
      fallback.push(entry.id);
    }
  }
  return { loaded, fallback };
}

let inflight: Promise<WorkletLoadResult> | null = null;

/**
 * Single-Flight: der erste Aufruf laedt, alle weiteren warten auf dasselbe
 * Ergebnis. So kann sowohl `audioEngine.init()` als auch die React-Startkette
 * aufrufen, ohne die Module doppelt (oder zu spaet) zu registrieren.
 */
export function ensureAudioWorkletsLoaded(options: LoadWorkletsOptions): Promise<WorkletLoadResult> {
  if (!inflight) {
    inflight = loadWorkletsOnce(options).catch((err) => ({
      loaded: [],
      fallback: [],
      manifestError: (err as Error).message,
    }));
  }
  return inflight;
}

/** Nur fuer Tests: setzt den Single-Flight-Zustand zurueck. */
export function resetWorkletLoaderForTests(): void {
  inflight = null;
}
