/**
 * audioMONASTRY · VisualMONK – RunPod-Video-Client (Wan2.2 image->video)
 * =====================================================================
 * Ruft den Serverless-Endpoint der Rolle `video` auf. Der Worker ist ein
 * ComfyUI/Wan2.2-Image-to-Video-Worker:
 *   Input:  { image_base64: <ROHES base64, KEIN data:-Praefix>, prompt, negative_prompt?, width?, height?, steps?, cfg?, seed? }
 *   Output: { video: <rohes base64 mp4> }
 * Ein `data:`-Praefix am Bild laesst den Worker mit "Incorrect padding"
 * scheitern (live verifiziert 2026-09-11) – deshalb wird hier immer der
 * reine Base64-Teil gesendet und das Ergebnis als data-URI zurueckgegeben.
 */

export interface VideoResult {
  /** data-URI (`data:video/mp4;base64,...`). */
  video: string;
  prompt: string;
  durationMs: number;
}

export interface VideoOptions {
  endpointId?: string;
  apiKey?: string;
  steps?: number;
  width?: number;
  height?: number;
  seed?: number;
  cfg?: number;
  negativePrompt?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export class VideoError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VideoError';
    this.code = code;
  }
}

function env(name: string): string {
  const v = (typeof process !== 'undefined' && process.env ? process.env[name] : undefined)?.trim();
  return v ?? '';
}

export function videoEndpointId(): string {
  return env('RUNPOD_ENDPOINT_ID_VIDEO');
}

/** Entfernt ein evtl. vorhandenes `data:…;base64,`-Praefix. */
export function stripDataUri(value: string): string {
  const s = String(value ?? '').trim();
  const comma = s.indexOf('base64,');
  return comma >= 0 ? s.slice(comma + 7).replace(/\s+/g, '') : s.replace(/\s+/g, '');
}

/** Zieht das Video (rohes base64 oder data-URI) aus der Worker-Ausgabe. */
export function extractVideo(output: unknown): string | null {
  if (typeof output === 'string') {
    if (output.startsWith('data:video')) return output;
    if (/^https?:\/\/.+\.(mp4|webm|mov)(\?.*)?$/i.test(output)) return output;
    if (output.length > 100) return output;
    return null;
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = extractVideo(item);
      if (found) return found;
    }
    return null;
  }
  if (output && typeof output === 'object') {
    const rec = output as Record<string, unknown>;
    for (const key of ['video', 'video_base64', 'output', 'videos', 'url', 'video_url']) {
      if (key in rec) {
        const found = extractVideo(rec[key]);
        if (found) return found;
      }
    }
    for (const value of Object.values(rec)) {
      const found = extractVideo(value);
      if (found) return found;
    }
  }
  return null;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'audiomonastry-agent' };
}

/** Erzeugt einen Clip aus einem Eingangsbild (Wan2.2 image->video). */
export async function generateVideo(imageBase64: string, prompt: string, opts: VideoOptions = {}): Promise<VideoResult> {
  const endpointId = opts.endpointId || videoEndpointId();
  const apiKey = opts.apiKey || env('RUNPOD_API_KEY') || env('RP_API_KEY');
  const doFetch = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 1_800_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;

  if (!endpointId) throw new VideoError('NO_ENDPOINT', 'RUNPOD_ENDPOINT_ID_VIDEO ist nicht gesetzt');
  if (!apiKey) throw new VideoError('NO_KEY', 'RUNPOD_API_KEY/RP_API_KEY ist nicht gesetzt');
  const image = stripDataUri(imageBase64);
  if (!image) throw new VideoError('NO_IMAGE', 'imageBase64 fehlt');
  const clean = String(prompt ?? '').trim().slice(0, 1200) || 'gentle camera push in, subtle motion';

  const base = `https://api.runpod.ai/v2/${encodeURIComponent(endpointId)}`;
  const input: Record<string, unknown> = {
    image_base64: image,
    prompt: clean,
    steps: opts.steps ?? 6,
    width: opts.width ?? 480,
    height: opts.height ?? 832,
    cfg: opts.cfg ?? 2.0,
  };
  if (opts.negativePrompt) input.negative_prompt = opts.negativePrompt.slice(0, 500);
  if (typeof opts.seed === 'number') input.seed = opts.seed;

  const deadline = started + timeoutMs;
  let job: Record<string, unknown>;
  try {
    const runResp = await doFetch(`${base}/run`, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify({ input }) });
    if (!runResp.ok) throw new VideoError('HTTP', `run HTTP ${runResp.status}`);
    job = (await runResp.json()) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof VideoError) throw e;
    throw new VideoError('NETWORK', `run fehlgeschlagen: ${(e as Error).message}`);
  }

  const jobId = String(job.id ?? '');
  if (!jobId) throw new VideoError('NO_JOB', 'Worker lieferte keine Job-ID');
  let status = String(job.status ?? '');
  while (status !== 'COMPLETED' && status !== 'FAILED' && status !== 'CANCELLED' && status !== 'TIMED_OUT') {
    if (Date.now() > deadline) throw new VideoError('TIMEOUT', `Video-Job nach ${timeoutMs} ms nicht fertig`);
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const stResp = await doFetch(`${base}/status/${encodeURIComponent(jobId)}`, { headers: authHeaders(apiKey) });
    if (!stResp.ok) throw new VideoError('HTTP', `status HTTP ${stResp.status}`);
    job = (await stResp.json()) as Record<string, unknown>;
    status = String(job.status ?? '');
  }
  if (status !== 'COMPLETED') throw new VideoError(status || 'FAILED', String(job.error ?? `Video-Job ${status}`).slice(0, 300));

  const raw = extractVideo(job.output);
  if (!raw) throw new VideoError('NO_VIDEO', 'Worker lieferte kein Video');
  const video = raw.startsWith('data:video') ? raw : `data:video/mp4;base64,${raw}`;
  return { video, prompt: clean, durationMs: Date.now() - started };
}
