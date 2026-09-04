/**
 * audioMONASTRY · AI Orchestrator – Model Registry (TS-Spiegel)
 * =============================================================
 * Kanonische Quelle im Betrieb ist `services/samplemonk-ai-runtime/model_manifest.json`
 * (wird vom Container geladen). Dieses Modul ist der TS-Spiegel für den
 * Orchestrator (Routing, VRAM-Planung, Tests). Produktionsregel:
 * feste Revisionen – kein `latest`.
 */
import type { AiTask, ModelDefinition, ModelLoadClass } from './types';

export const MODEL_DEFINITIONS: readonly ModelDefinition[] = [
  {
    id: 'ast-audioset',
    repository: 'MIT/ast-finetuned-audioset-10-10-0.4593',
    revision: 'f826b80d28226b62986cc218e5cec390b1096902',
    task: 'audio.classify',
    framework: 'transformers',
    estimatedVRAM: 3,
    estimatedRAM: 4,
    loadPriority: 1,
    preload: true,
    loadClass: 'CORE',
    quantization: 'fp16',
    dependencies: ['transformers', 'torch', 'soundfile'],
    inputFormats: ['wav', 'mp3', 'flac'],
    outputFormats: ['json'],
    maxDuration: 10,
    concurrency: 2,
    timeout: 60,
    license: 'MIT',
  },
  {
    id: 'whisper-large-v3',
    repository: 'openai/whisper-large-v3',
    revision: '06f233fe06e710322aca913c1bc4249a0d71fce1',
    task: 'audio.transcribe',
    framework: 'transformers',
    estimatedVRAM: 5,
    estimatedRAM: 6,
    loadPriority: 2,
    preload: true,
    loadClass: 'CORE',
    quantization: 'int8',
    dependencies: ['transformers', 'torch'],
    inputFormats: ['wav', 'mp3'],
    outputFormats: ['json'],
    maxDuration: 30,
    concurrency: 1,
    timeout: 120,
    license: 'Apache-2.0',
  },
  {
    id: 'clap-music',
    repository: 'laion/larger_clap_music',
    revision: 'a0b4534a14f58e20944452dff00a22a06ce629d1',
    task: 'audio.embed',
    framework: 'transformers',
    estimatedVRAM: 4,
    estimatedRAM: 6,
    loadPriority: 3,
    preload: true,
    loadClass: 'FREQUENT',
    quantization: 'fp16',
    dependencies: ['transformers', 'torch', 'soundfile'],
    inputFormats: ['wav'],
    outputFormats: ['json'],
    maxDuration: 10,
    concurrency: 2,
    timeout: 60,
    license: 'MIT',
  },
  {
    id: 'musicgen-small',
    repository: 'facebook/musicgen-small',
    revision: '4c8334b02c6ec4e8664a91979669a501ec497792',
    task: 'audio.generate',
    framework: 'transformers',
    estimatedVRAM: 3,
    estimatedRAM: 4,
    loadPriority: 4,
    preload: true,
    loadClass: 'FREQUENT',
    quantization: 'int8',
    dependencies: ['transformers', 'torch', 'scipy'],
    inputFormats: ['text'],
    outputFormats: ['wav'],
    maxDuration: 30,
    concurrency: 1,
    timeout: 120,
    license: 'CC-BY-NC (private/research OK)',
  },
  {
    id: 'mms-tts-deu',
    repository: 'facebook/mms-tts-deu',
    revision: '5cbe521869fcf9da4b2b3e85d7810e3005a121dc',
    task: 'tts',
    framework: 'transformers',
    estimatedVRAM: 2,
    estimatedRAM: 3,
    loadPriority: 5,
    preload: true,
    loadClass: 'FREQUENT',
    quantization: 'fp16',
    dependencies: ['transformers', 'torch', 'scipy'],
    inputFormats: ['text'],
    outputFormats: ['wav'],
    maxDuration: 30,
    concurrency: 2,
    timeout: 60,
    license: 'CC-BY-NC (private/research OK)',
  },
  {
    id: 'qwen3-tts-06b',
    repository: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
    revision: '85e237c12c027371202489a0ec509ded67b5e4b5',
    task: 'tts',
    framework: 'custom',
    estimatedVRAM: 5,
    estimatedRAM: 6,
    loadPriority: 5,
    preload: true,
    loadClass: 'FREQUENT',
    quantization: 'bf16',
    dependencies: ['qwen-tts', 'transformers', 'torch', 'accelerate', 'scipy', 'soundfile'],
    inputFormats: ['text'],
    outputFormats: ['wav'],
    maxDuration: 30,
    concurrency: 1,
    timeout: 120,
    license: 'Apache-2.0',
  },
  {
    id: 'musicgen-medium',
    repository: 'facebook/musicgen-medium',
    revision: 'd3bd7b00761b78ad7a8a05145ee31e7832e9916c',
    task: 'audio.generate',
    framework: 'transformers',
    estimatedVRAM: 9,
    estimatedRAM: 12,
    loadPriority: 6,
    preload: false,
    loadClass: 'ON_DEMAND',
    quantization: 'int8',
    dependencies: ['transformers', 'torch', 'scipy'],
    inputFormats: ['text'],
    outputFormats: ['wav'],
    maxDuration: 30,
    concurrency: 1,
    timeout: 180,
    license: 'CC-BY-NC (private/research OK)',
  },
  {
    id: 'stable-audio-open-1.0',
    repository: 'stabilityai/stable-audio-open-1.0',
    revision: 'f21265c1e2710b3bd2386596943f0007f55f802e',
    task: 'audio.generate',
    framework: 'custom',
    estimatedVRAM: 10,
    estimatedRAM: 14,
    loadPriority: 7,
    preload: false,
    loadClass: 'ON_DEMAND',
    quantization: 'fp16',
    dependencies: ['diffusers', 'torch', 'transformers', 'scipy', 'soundfile'],
    inputFormats: ['text'],
    outputFormats: ['wav'],
    maxDuration: 47,
    concurrency: 1,
    timeout: 300,
    license: 'stability-community (gated)',
  },
  {
    id: 'bark',
    repository: 'suno/bark',
    revision: '70a8a7d34168586dc5d028fa9666aceade177992',
    task: 'tts',
    framework: 'transformers',
    estimatedVRAM: 8,
    estimatedRAM: 8,
    loadPriority: 7,
    preload: false,
    loadClass: 'ON_DEMAND',
    quantization: 'int8',
    dependencies: ['transformers', 'torch', 'scipy'],
    inputFormats: ['text'],
    outputFormats: ['wav'],
    maxDuration: 14,
    concurrency: 1,
    timeout: 180,
    license: 'verify',
  },
  {
    id: 'pyannote-diarization',
    repository: 'pyannote/speaker-diarization-3.1',
    revision: '84fd25912480287da0247647c3d2b4853cb3ee5d',
    task: 'audio.analyze',
    framework: 'transformers',
    estimatedVRAM: 6,
    estimatedRAM: 8,
    loadPriority: 8,
    preload: false,
    loadClass: 'ON_DEMAND',
    quantization: 'fp16',
    dependencies: ['torch', 'pyannote.audio'],
    inputFormats: ['wav'],
    outputFormats: ['json'],
    maxDuration: 600,
    concurrency: 1,
    timeout: 300,
    license: 'gated',
  },
  {
    id: 'qwen-omni',
    repository: 'Qwen/Qwen2.5-Omni-7B',
    revision: 'ae9e1690543ffd5c0221dc27f79834d0294cba00',
    task: 'multimodal',
    framework: 'transformers',
    estimatedVRAM: 18,
    estimatedRAM: 24,
    loadPriority: 9,
    preload: false,
    loadClass: 'RARE',
    quantization: 'int8',
    dependencies: ['transformers', 'torch'],
    inputFormats: ['audio', 'image', 'text'],
    outputFormats: ['json'],
    maxDuration: 120,
    concurrency: 1,
    timeout: 300,
    license: 'Apache-2.0',
  },
];

const byId = new Map(MODEL_DEFINITIONS.map((m) => [m.id, m]));

export function getModelDefinition(id: string): ModelDefinition | undefined {
  return byId.get(id);
}

export function listModels(filter?: { task?: AiTask; loadClass?: ModelLoadClass }): ModelDefinition[] {
  return MODEL_DEFINITIONS.filter(
    (m) => (!filter?.task || m.task === filter.task) && (!filter?.loadClass || m.loadClass === filter.loadClass),
  );
}

/** Modelle einer Ladeklasse, sortiert nach loadPriority. */
export function modelsByLoadClass(loadClass: ModelLoadClass): ModelDefinition[] {
  return listModels({ loadClass }).sort((a, b) => a.loadPriority - b.loadPriority);
}

/** Validierung: keine `latest`-Revisionen, eindeutige IDs. */
export function validateRegistry(models: readonly ModelDefinition[] = MODEL_DEFINITIONS): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const m of models) {
    if (ids.has(m.id)) errors.push(`duplicate id: ${m.id}`);
    ids.add(m.id);
    if (!m.revision || m.revision.trim().toLowerCase() === 'latest') {
      errors.push(`model ${m.id}: revision pinning required (no 'latest')`);
    }
    if (m.estimatedVRAM <= 0) errors.push(`model ${m.id}: estimatedVRAM must be > 0`);
    if (!Number.isInteger(m.concurrency) || m.concurrency < 1) errors.push(`model ${m.id}: concurrency must be >= 1`);
  }
  return errors;
}

/** Summe estimatedVRAM aller Modelle (für VRAM-Planung). */
export function totalEstimatedVram(models: readonly ModelDefinition[] = MODEL_DEFINITIONS): number {
  return models.reduce((sum, m) => sum + m.estimatedVRAM, 0);
}
