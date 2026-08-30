/**
 * audioMONASTRY · VoiceMONK Env/Model-Auswahl
 * ============================================
 * Server-seitige Env-Werte (process.env, via dotenv geladen).
 * Im Browser laufen HF-Aufrufe ausschließlich über den Server-Proxy
 * (/api/voice/*) – API-Keys werden niemals ins Client-Bundle gelegt.
 */

const NODE_ENV =
  typeof process !== 'undefined' && process.env
    ? (process.env as Record<string, string | undefined>)
    : undefined;

/** Liefert einen Env-Wert (nur Node/Server; im Browser bewusst undefined). */
export function envKey(name: string): string | undefined {
  const nodeVal = NODE_ENV?.[name]?.trim();
  return nodeVal && nodeVal.length > 0 ? nodeVal : undefined;
}

/** Beste kostenlose Modelle (HF-Inference) für Stimmen, Gesang und Songs. */
export const VOICE_MODELS = {
  /** Stimmen: beste kostenlose deutsche TTS-Stimme (MMS). */
  tts: 'facebook/mms-tts-deu',
  /** Gesang: Suno Bark – expressive Stimmen & Gesang, multilingual. */
  singing: 'suno/bark',
  /** Lieder: beste praktikable MusicGen-Qualität auf der Free-API. */
  song: 'facebook/musicgen-medium',
  /** Lieder: zuverlässiger Fallback, wenn Medium nicht verfügbar ist. */
  songFallback: 'facebook/musicgen-small',
} as const;

export type VoiceModelKind = keyof typeof VOICE_MODELS;

/** Liefert den konfigurierten Modell-Namen (Env-Override) oder den Default. */
export function voiceModel(kind: VoiceModelKind, envName: string): string {
  return envKey(envName) ?? VOICE_MODELS[kind];
}
