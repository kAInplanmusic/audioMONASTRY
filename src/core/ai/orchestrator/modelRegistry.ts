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
    revision: 'REVISION_PENDING',
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
    revision: 'REVISION_PENDING',
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
    repository: 'laion/larger-clap-music',
    revision: 'REVISION_PENDING',
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
    revision: 'REVISION_PENDING',
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
    license: 'CC-BY-NC (verify)',
  },
  {
    id: 'mms-tts-deu',
    repository: 'facebook/mms-tts-deu',
    revision: 'REVISION_PENDING',
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
    license: 'CC-BY-NC (verify)',
  },
  {
    id: 'musicgen-medium',
    repository: 'facebook/musicgen-medium',
    revision: 'REVISION_PENDING',
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
    license: 'CC-BY-NC (verify)',
  },
  {
    id: 'bark',
    repository: 'suno/bark',
    revision: 'REVISION_PENDING',
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
    revision: 'REVISION_PENDING',
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
    revision: 'REVISION_PENDING',
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
