import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SHOW_DEFAULTS,
  createShowState,
  effectiveDurationS,
  mergeableClips,
  nextSceneIndex,
  sceneAt,
  showFade,
  showTotalDurationS,
  summarizeShow,
  tickShow,
  type ShowScene,
} from '../src/core/visual/showOrchestrator';
import {
  CLIP_ETA_COLD_MS,
  ClipPipelineError,
  clipEtaMs,
  formatEtaMs,
  generateClipFromPrompt,
} from '../src/core/ai/vision/clipPipeline';
import { buildMotionPrompt } from '../src/core/ai/vision/visionPrompt';
import type { VisionImageResult, VisionOptions } from '../src/core/ai/vision/runpodVision';
import type { VideoOptions, VideoResult } from '../src/core/ai/vision/runpodVideo';
import { AiShowMergeSchema, AiVideoClipSchema } from '../src/types/zod/schemas';
import { IDLE_AUDIO_FEATURES, type AudioFeatures } from '../src/core/visual/types';
import {
  MAX_MERGE_CLIP_BYTES,
  MergeError,
  buildConcatFile,
  buildMergeArgs,
  loadMergeSource,
  mergeClipBuffers,
  resetFfmpegProbe,
} from '../server/visionShow';
import {
  contentTypeForArtifact,
  dataUriToBuffer,
  flattenArtifactName,
  isSafeArtifactName,
  readArtifact,
  resetR2Block,
  saveArtifact,
} from '../server/visionArtifacts';

const IMAGE_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const VIDEO_URI = 'data:video/mp4;base64,AAAAIGZ0eXBpc29t';
/** Für die Zod-Prüfung: die API verlangt einen realistisch langen data-URI. */
const MERGE_URI = `data:video/mp4;base64,${'A'.repeat(200)}`;

function scene(over: Partial<ShowScene> = {}): ShowScene {
  return {
    id: 's1',
    label: 'Szene',
    prompt: 'p',
    kind: 'image',
    src: IMAGE_URI,
    durationS: 10,
    ...over,
  };
}

function features(over: Partial<AudioFeatures> = {}): AudioFeatures {
  return { ...IDLE_AUDIO_FEATURES, ...over };
}

describe('VisualMONK – Show-Orchestrator (Ablauf)', () => {
  it('rechnet die effektive Standdauer aus Wunsch, Clip-Länge und Deckel', () => {
    expect(effectiveDurationS(scene({ durationS: 20 }))).toBe(20);
    expect(effectiveDurationS(scene({ durationS: 20, kind: 'clip', mediaDurationS: 5 }))).toBe(5);
    expect(effectiveDurationS(scene({ durationS: 0 }))).toBe(SHOW_DEFAULTS.maxSceneS);
    // Kein Durchblitzen: Untergrenze 1 s.
    expect(effectiveDurationS(scene({ durationS: 0.2 }))).toBe(1);
    // Obergrenze greift auch gegen lange Clips.
    expect(effectiveDurationS(scene({ durationS: 600, kind: 'clip', mediaDurationS: 600 }))).toBe(SHOW_DEFAULTS.maxSceneS);
  });

  it('summiert und zählt die Show', () => {
    const scenes = [scene({ id: 'a', durationS: 4 }), scene({ id: 'b', kind: 'clip', durationS: 10, mediaDurationS: 6 })];
    expect(showTotalDurationS(scenes)).toBe(10);
    expect(summarizeShow(scenes)).toEqual({ scenes: 2, clips: 1, images: 1, totalS: 10 });
  });

  it('liefert bei leerer Show einen neutralen Tick', () => {
    const state = createShowState(0, 0);
    const tick = tickShow(state, [], features(), 1000);
    expect(tick.sceneIndex).toBe(-1);
    expect(tick.advanced).toBe(false);
    expect(tick.totalS).toBe(0);
  });

  it('schaltet nach Ablauf der Standdauer weiter und läuft als Schleife', () => {
    const scenes = [scene({ id: 'a', durationS: 4 }), scene({ id: 'b', durationS: 10 })];
    const state = createShowState(0, 1000);
    const tick = tickShow(state, scenes, features(), 6_000);
    expect(tick.advanced).toBe(true);
    expect(tick.reason).toBe('duration');
    expect(tick.sceneIndex).toBe(1);
    // Zustand unverändert (rein) – der neue Zustand kommt zurück.
    expect(state.index).toBe(0);
    const last = tickShow(tick.state, scenes, features(), 6_000 + 11_000);
    expect(last.sceneIndex).toBe(0);
    // Zwei Wechsel: erst per Dauer, dann zurück auf Szene 1.
    expect(last.state.transitions).toBe(2);
  });

  it('lässt Audio erst nach der Mindeststandzeit umschalten', () => {
    const scenes = [scene({ id: 'a', durationS: 30 })];
    const state = createShowState(0, 0);
    // Harter Schlag direkt nach dem Wechsel -> kein Flackern.
    expect(tickShow(state, scenes, features({ onset: 0.99 }), 1_000).advanced).toBe(false);
    // Nach der Mindeststandzeit greift der Beat.
    const beat = tickShow(state, scenes, features({ onset: 0.99 }), SHOW_DEFAULTS.minDwellS * 1000 + 50);
    expect(beat.advanced).toBe(true);
    expect(beat.reason).toBe('beat');
  });

  it('schaltet bei einem Energie-Anstieg seit Szenenbeginn (Drop)', () => {
    const scenes = [scene({ id: 'a', durationS: 30 }), scene({ id: 'b', durationS: 30 })];
    const state = createShowState(0, 0, 0.2);
    const calm = tickShow(state, scenes, features({ energy: 0.4 }), 5_000);
    expect(calm.advanced).toBe(false);
    const drop = tickShow(state, scenes, features({ energy: 0.62 }), 5_500);
    expect(drop.advanced).toBe(true);
    expect(drop.reason).toBe('energy');
    // Bezug wird auf die neue Szene gesetzt -> kein Dauerfeuer.
    const after = tickShow(drop.state, scenes, features({ energy: 0.65 }), 6_000);
    expect(after.advanced).toBe(false);
  });

  it('meldet den Crossfade-Fortschritt', () => {
    const scenes = [scene({ id: 'a', durationS: 30 })];
    const state = createShowState(0, 0);
    expect(tickShow(state, scenes, features(), 400).fade).toBeCloseTo(0.5, 5);
    expect(tickShow(state, scenes, features(), 2_000).fade).toBe(1);
    expect(showFade(state, 0)).toBe(0);
  });

  it('führt nur Clips mit Quelle zusammen', () => {
    const scenes = [
      scene({ id: 'a', kind: 'clip', src: VIDEO_URI }),
      scene({ id: 'b', kind: 'image' }),
      scene({ id: 'c', kind: 'clip', src: '' }),
      scene({ id: 'd', kind: 'clip', src: VIDEO_URI }),
    ];
    expect(mergeableClips(scenes).map((s) => s.id)).toEqual(['a', 'd']);
  });

  it('kennt Index-Grenzen', () => {
    expect(nextSceneIndex(1, 2)).toBe(0);
    expect(nextSceneIndex(0, 0)).toBe(-1);
    expect(sceneAt(createShowState(9, 0), [scene({ id: 'a' }), scene({ id: 'b' })])?.id).toBe('b');
    expect(sceneAt(createShowState(0, 0), [])).toBeNull();
  });
});

describe('VisualMONK – Bewegungs-Prompt (image->video)', () => {
  it('überträgt Energie, Stil und Tempo in eine Bewegung', () => {
    const fast = buildMotionPrompt({ text: 'Leuchtturm', style: 'fire', energy: 0.9, bpm: 150 });
    expect(fast).toContain('fast push in');
    expect(fast).toContain('embers');
    expect(fast).toContain('fast beat');
    expect(fast).toContain('Leuchtturm');
    expect(buildMotionPrompt({ energy: 0.1 })).toContain('very slow drift');
    expect(buildMotionPrompt({})).toContain('gentle camera push in');
    expect(buildMotionPrompt({ text: 'x'.repeat(900) }).length).toBeLessThanOrEqual(500);
  });
});

describe('VisualMONK – Text→Clip-Kette', () => {
  /** Attrappen der beiden Rollen-Aufrufe (typgleich, damit die Kette geprüft wird). */
  const imageOk = (image = IMAGE_URI, seed = 7, durationMs = 11) =>
    vi.fn(async (_prompt: string, _opts?: VisionOptions): Promise<VisionImageResult> => ({ image, prompt: 'p', seed, durationMs }));
  const videoOk = (video = VIDEO_URI, durationMs = 22) =>
    vi.fn(async (_image: string, _prompt: string, _opts?: VideoOptions): Promise<VideoResult> => ({ video, prompt: 'p', durationMs }));

  it('erzeugt erst das Bild und schiebt genau dieses Bild in den Video-Schritt', async () => {
    const image = imageOk();
    const video = videoOk();
    const res = await generateClipFromPrompt({ text: 'Leuchtturm im Sturm', style: 'noir', energy: 0.8, bpm: 150 }, { image, video });

    expect(image).toHaveBeenCalledTimes(1);
    expect(video).toHaveBeenCalledTimes(1);
    expect(image.mock.calls[0][0]).toContain('Leuchtturm im Sturm');
    expect(image.mock.calls[0][0]).toContain('film noir');
    // Kette: der Video-Schritt bekommt das Bild aus Schritt 1.
    expect(video.mock.calls[0][0]).toBe(IMAGE_URI);
    expect(String(video.mock.calls[0][1])).toContain('push in');
    expect(res.image).toBe(IMAGE_URI);
    expect(res.video).toBe(VIDEO_URI);
    expect(res.seed).toBe(7);
    expect(res.imageMs).toBe(11);
    expect(res.videoMs).toBe(22);
  });

  it('bricht ohne Bild ab und ruft den Video-Worker nicht', async () => {
    const image = imageOk('');
    const video = videoOk();
    const run = generateClipFromPrompt({ text: 'x' }, { image, video });
    await expect(run).rejects.toMatchObject({ code: 'NO_IMAGE' });
    await expect(run).rejects.toBeInstanceOf(ClipPipelineError);
    expect(video).not.toHaveBeenCalled();
  });

  it('meldet einen leeren Clip als NO_VIDEO', async () => {
    const image = imageOk();
    const video = videoOk('');
    await expect(generateClipFromPrompt({ text: 'x' }, { image, video })).rejects.toMatchObject({ code: 'NO_VIDEO' });
  });

  it('nutzt einen eigenen Bewegungs-Hinweis, wenn angegeben', async () => {
    const image = imageOk(IMAGE_URI, 1, 1);
    const video = videoOk(VIDEO_URI, 1);
    const res = await generateClipFromPrompt({ text: 'Stadt', motion: 'langsamer Zoom auf den Turm' }, { image, video });
    expect(res.motionPrompt).toContain('langsamer Zoom auf den Turm');
  });

  it('nennt eine ehrliche Wartezeit', () => {
    expect(clipEtaMs(false)).toBe(CLIP_ETA_COLD_MS);
    expect(clipEtaMs(true)).toBeLessThan(CLIP_ETA_COLD_MS);
    expect(formatEtaMs(45_000)).toBe('45 s');
    expect(formatEtaMs(240_000)).toBe('4 min');
    expect(formatEtaMs(250_000)).toBe('4 min 10 s');
  });
});

describe('VisualMONK – Validierung (Zod)', () => {
  it('nimmt einen Clip-Auftrag mit minimalen Feldern', () => {
    expect(AiVideoClipSchema.safeParse({ prompt: 'Nebel über Wasser' }).success).toBe(true);
    expect(AiVideoClipSchema.safeParse({ prompt: 'x', style: 'nope' }).success).toBe(false);
    expect(AiVideoClipSchema.safeParse({ prompt: '   ' }).success).toBe(false);
  });

  it('verlangt beim Merge je Clip eine Quelle und begrenzt die Anzahl', () => {
    const ok = AiShowMergeSchema.safeParse({ clips: [{ dataUri: MERGE_URI }] });
    expect(ok.success).toBe(true);
    expect(AiShowMergeSchema.safeParse({ clips: [{}] }).success).toBe(false);
    expect(AiShowMergeSchema.safeParse({ clips: [] }).success).toBe(false);
    expect(AiShowMergeSchema.safeParse({ clips: Array.from({ length: 11 }, () => ({ dataUri: MERGE_URI })) }).success).toBe(false);
    expect(AiShowMergeSchema.safeParse({ clips: [{ url: 'https://x/y.mp4' }], fps: 8 }).success).toBe(false);
  });
});

describe('VisualMONK – Show-Merge (ffmpeg)', () => {
  afterEach(() => resetFfmpegProbe());

  it('baut die concat-Liste mit gequoteten Pfaden', () => {
    expect(buildConcatFile([{ file: '/tmp/a.mp4' }, { file: "/tmp/it's.mp4" }])).toBe("file '/tmp/a.mp4'\nfile '/tmp/it'\\''s.mp4'\n");
  });

  it('normalisiert im ffmpeg-Aufruf Format, Seitenverhältnis und Frames', () => {
    const args = buildMergeArgs('/tmp/c.txt', '/tmp/out.mp4', { width: 1024, height: 576, fps: 24 });
    expect(args).toContain('concat');
    expect(args).toContain('/tmp/c.txt');
    expect(args[args.length - 1]).toBe('/tmp/out.mp4');
    const filter = args[args.indexOf('-vf') + 1];
    expect(filter).toContain('scale=1024:576:force_original_aspect_ratio=decrease');
    expect(filter).toContain('pad=1024:576');
    expect(filter).toContain('fps=24');
    expect(filter).toContain('format=yuv420p');
    expect(args).toContain('-an');
  });

  it('wirft ohne Clips NO_SOURCES', async () => {
    await expect(mergeClipBuffers([])).rejects.toBeInstanceOf(MergeError);
    await expect(mergeClipBuffers([])).rejects.toMatchObject({ code: 'NO_SOURCES' });
  });

  it('reicht einen einzelnen Clip unverändert durch (kein Re-Encode)', async () => {
    const bytes = Buffer.from('fake-mp4');
    const res = await mergeClipBuffers([{ name: 'a.mp4', bytes }]);
    expect(res.reencoded).toBe(false);
    expect(res.clipCount).toBe(1);
    expect(res.video.equals(bytes)).toBe(true);
  });

  it('meldet fehlendes ffmpeg als NO_FFMPEG statt still zu scheitern', async () => {
    const res = mergeClipBuffers(
      [
        { name: 'a.mp4', bytes: Buffer.from('a') },
        { name: 'b.mp4', bytes: Buffer.from('b') },
      ],
      { ffmpegPath: '/nonexistent-ffmpeg-binary' },
    );
    await expect(res).rejects.toMatchObject({ code: 'NO_FFMPEG' });
  });

  it('holt Material aus dataUri, Artefakt-Pfad und HTTP', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'amonk-art-'));
    const prevDir = process.env.VISION_ARTIFACT_DIR;
    const prevKeys = { id: process.env.CFR2_ACCESS_KEY_ID, secret: process.env.CFR2_SECRET_ACCESS_KEY, acc: process.env.CFR2_ACCOUNT_ID };
    process.env.VISION_ARTIFACT_DIR = dir;
    delete process.env.CFR2_ACCESS_KEY_ID;
    delete process.env.CFR2_SECRET_ACCESS_KEY;
    delete process.env.CFR2_ACCOUNT_ID;
    resetR2Block();
    try {
      // dataUri
      const fromUri = await loadMergeSource({ dataUri: VIDEO_URI }, 0);
      expect(fromUri.bytes.length).toBeGreaterThan(0);

      // Artefakt-Pfad (serve-seitige Ablage, kein HTTP)
      const stored = await saveArtifact('vision/show/test.mp4', Buffer.from('artifact-bytes'), 'video/mp4');
      expect(stored.store).toBe('local');
      const fromArtifact = await loadMergeSource({ url: stored.url, label: 'Szene 1' }, 1);
      expect(fromArtifact.bytes.toString()).toBe('artifact-bytes');
      expect(fromArtifact.name).toBe('Szene 1');

      // HTTP über injiziertes fetch
      const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })) as unknown as typeof fetch;
      const fromHttp = await loadMergeSource({ url: 'https://example.test/clip.mp4' }, 2, { fetchImpl });
      expect(fromHttp.bytes.length).toBe(3);

      // Fehlerpfade
      await expect(loadMergeSource({ url: 'ftp://x/y.mp4' }, 3)).rejects.toMatchObject({ code: 'BAD_SOURCE' });
      await expect(loadMergeSource({ url: stored.url.replace('test.mp4', 'fehlt.mp4') }, 4)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(loadMergeSource({}, 5)).rejects.toMatchObject({ code: 'BAD_SOURCE' });
      await expect(
        loadMergeSource({ dataUri: `data:video/mp4;base64,${Buffer.alloc(MAX_MERGE_CLIP_BYTES + 4).toString('base64')}` }, 6),
      ).rejects.toMatchObject({ code: 'TOO_LARGE' });
      const failingFetch = vi.fn(async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch;
      await expect(loadMergeSource({ url: 'https://example.test/x.mp4' }, 7, { fetchImpl: failingFetch })).rejects.toMatchObject({ code: 'FETCH_FAILED' });
    } finally {
      process.env.VISION_ARTIFACT_DIR = prevDir;
      if (prevKeys.id) process.env.CFR2_ACCESS_KEY_ID = prevKeys.id;
      if (prevKeys.secret) process.env.CFR2_SECRET_ACCESS_KEY = prevKeys.secret;
      if (prevKeys.acc) process.env.CFR2_ACCOUNT_ID = prevKeys.acc;
      resetR2Block();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('VisualMONK – Ablage (R2 mit lokalem Fallback)', () => {
  it('erkennt gültige Artefakt-Namen', () => {
    expect(isSafeArtifactName('vision__clip-abc.mp4')).toBe(true);
    expect(isSafeArtifactName('a.PNG')).toBe(true);
    expect(isSafeArtifactName('../etc/passwd.png')).toBe(false);
    expect(isSafeArtifactName('a/b.png')).toBe(false);
    expect(isSafeArtifactName('a.exe')).toBe(false);
    expect(isSafeArtifactName('')).toBe(false);
    expect(contentTypeForArtifact('x.MP4')).toBe('video/mp4');
    expect(contentTypeForArtifact('x.txt')).toBeNull();
  });

  it('flacht Objekt-Keys flach und behält die Endung', () => {
    expect(flattenArtifactName('vision/clip/2026-09-11T10-00-00.mp4')).toBe('vision__clip__2026-09-11T10-00-00.mp4');
    const long = flattenArtifactName(`vision/${'a'.repeat(300)}.mp4`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('.mp4')).toBe(true);
  });

  it('liest data-URIs als Buffer (base64 und URL-kodiert)', () => {
    expect(dataUriToBuffer('data:image/png;base64,AAAA')?.length).toBe(3);
    expect(dataUriToBuffer('data:text/plain,hi%20there')?.toString()).toBe('hi there');
    expect(dataUriToBuffer('https://x/y.mp4')).toBeNull();
  });

  it('weicht ohne R2 auf die lokale Ablage aus und liest sie zurück', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'amonk-art-'));
    const prevDir = process.env.VISION_ARTIFACT_DIR;
    const prev = { id: process.env.CFR2_ACCESS_KEY_ID, secret: process.env.CFR2_SECRET_ACCESS_KEY, acc: process.env.CFR2_ACCOUNT_ID };
    process.env.VISION_ARTIFACT_DIR = dir;
    delete process.env.CFR2_ACCESS_KEY_ID;
    delete process.env.CFR2_SECRET_ACCESS_KEY;
    delete process.env.CFR2_ACCOUNT_ID;
    resetR2Block();
    try {
      const stored = await saveArtifact('vision/clip/2026-09-11T10-00-00-ab12cd.mp4', Buffer.from('clip-bytes'), 'video/mp4');
      expect(stored.store).toBe('local');
      expect(stored.url.startsWith('/api/ai/vision/artifact/')).toBe(true);
      expect(stored.note).toBeTruthy();
      const name = decodeURIComponent(stored.url.split('/').pop() as string);
      const back = await readArtifact(name);
      expect(back?.toString()).toBe('clip-bytes');
      // Pfad-Ausbruch wird abgelehnt.
      expect(await readArtifact('../../etc/passwd')).toBeNull();
    } finally {
      process.env.VISION_ARTIFACT_DIR = prevDir;
      if (prev.id) process.env.CFR2_ACCESS_KEY_ID = prev.id;
      if (prev.secret) process.env.CFR2_SECRET_ACCESS_KEY = prev.secret;
      if (prev.acc) process.env.CFR2_ACCOUNT_ID = prev.acc;
      resetR2Block();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
