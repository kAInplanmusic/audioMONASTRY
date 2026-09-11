/**
 * audioMONASTRY · VisualMONK – RunPod-Vision-Client (FLUX)
 * ========================================================
 * Ruft den Serverless-Endpoint der Rolle `vision` auf (FLUX.1-dev) und liefert
 * das erzeugte Bild als data-URI (oder URL). Der Worker-Input ist
 * `{ input: { prompt, num_inference_steps, width, height } }`, der Output traegt
 * `image_url` (data-URI) bzw. `images`.
 *
 * Bewusst ohne feste Endpoint-ID im Code: die ID kommt aus
 * `RUNPOD_ENDPOINT_ID_VISION` (siehe .env.example).
 */

export interface VisionImageResult {
  /** data-URI (`data:image/png;base64,...`) oder Bild-URL. */
  image: string;
  prompt: string;
  seed?: number;
  durationMs: number;
}

export interface VisionOptions {
  endpointId?: string;
  apiKey?: string;
  steps?: number;
  width?: number;
  height?: number;
  /** Gesamtbudget inkl. Kaltstart (Default 15 min). */
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export class VisionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VisionError';
    this.code = code;
  }
}

function env(name: string): string {
  const v = (typeof process !== 'undefined' && process.env ? process.env[name] : undefined)?.trim();
  return v ?? '';
}

export function visionEndpointId(): string {
  return env('RUNPOD_ENDPOINT_ID_VISION');
}

/** Sucht rekursiv das erste Bild (data-URI oder URL) in der Worker-Ausgabe. */
export function extractVisionImage(output: unknown): string | null {
  if (typeof output === 'string') {
    if (output.startsWith('data:image')) return output;
    if (/^https?:\/\/.+\.(png|jpe?g|webp)(\?.*)?$/i.test(output)) return output;
    return null;
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = extractVisionImage(item);
      if (found) return found;
    }
    return null;
  }
  if (output && typeof output === 'object') {
    const rec = output as Record<string, unknown>;
    // Bevorzugt die bekannten FLUX-Felder, dann rekursiv.
    for (const key of ['image_url', 'image', 'url', 'images', 'output']) {
      if (key in rec) {
        const found = extractVisionImage(rec[key]);
        if (found) return found;
      }
    }
    for (const value of Object.values(rec)) {
      const found = extractVisionImage(value);
      if (found) return found;
    }
  }
  return null;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'audiomonastry-agent',
  };
}

/**
 * Erzeugt ein Bild. Nutzt `/runsync` und pollt bei kaltem Worker per
 * `/status/{id}` weiter (Kaltstart kann Minuten dauern).
 */
export async function generateVisionImage(prompt: string, opts: VisionOptions = {}): Promise<VisionImageResult> {
  const endpointId = opts.endpointId || visionEndpointId();
  const apiKey = opts.apiKey || env('RUNPOD_API_KEY') || env('RP_API_KEY');
  const doFetch = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 900_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;

  if (!endpointId) throw new VisionError('NO_ENDPOINT', 'RUNPOD_ENDPOINT_ID_VISION ist nicht gesetzt');
  if (!apiKey) throw new VisionError('NO_KEY', 'RUNPOD_API_KEY/RP_API_KEY ist nicht gesetzt');
  const clean = String(prompt ?? '').trim().slice(0, 1200);
  if (!clean) throw new VisionError('NO_PROMPT', 'prompt fehlt');

  const base = `https://api.runpod.ai/v2/${encodeURIComponent(endpointId)}`;
  const input = {
    prompt: clean,
    num_inference_steps: opts.steps ?? 25,
    width: opts.width ?? 1024,
    height: opts.height ?? 1024,
  };

  const deadline = started + timeoutMs;
  let job: Record<string, unknown>;
  try {
    const runResp = await doFetch(`${base}/runsync`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ input }),
    });
    if (!runResp.ok) throw new VisionError('HTTP', `runsync HTTP ${runResp.status}`);
    job = (await runResp.json()) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof VisionError) throw e;
    throw new VisionError('NETWORK', `runsync fehlgeschlagen: ${(e as Error).message}`);
  }

  const jobId = String(job.id ?? '');
  let status = String(job.status ?? '');
  while (status === 'IN_QUEUE' || status === 'IN_PROGRESS' || status === '') {
    if (Date.now() > deadline) throw new VisionError('TIMEOUT', `Vision-Job ${jobId} nach ${timeoutMs} ms nicht fertig`);
    if (!jobId) throw new VisionError('NO_JOB', 'Worker lieferte keine Job-ID');
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const stResp = await doFetch(`${base}/status/${encodeURIComponent(jobId)}`, { headers: authHeaders(apiKey) });
    if (!stResp.ok) throw new VisionError('HTTP', `status HTTP ${stResp.status}`);
    job = (await stResp.json()) as Record<string, unknown>;
    status = String(job.status ?? '');
  }

  if (status !== 'COMPLETED') throw new VisionError(status || 'FAILED', `Vision-Job ${status}`);

  const image = extractVisionImage(job.output);
  if (!image) throw new VisionError('NO_IMAGE', 'Worker lieferte kein Bild');
  const output = (job.output ?? {}) as Record<string, unknown>;
  const seed = typeof output.seed === 'number' ? output.seed : undefined;
  return { image, prompt: clean, seed, durationMs: Date.now() - started };
}
