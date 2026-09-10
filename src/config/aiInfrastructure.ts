// ============================================================================
// audioMONASTRY · AI-Infrastruktur-Kostenregel – 3-Rollen-GPU-Flotte
// ----------------------------------------------------------------------------
// Seit dem Flotten-Umbau (2026-09-10) läuft alle AI-Inferenz auf RunPod
// Serverless – verteilt auf GENAU DREI Rollen-Endpoints:
//
//   brain     lokales LLM (MOA-Planung, MCP-Tool-Calls, App-Steuerung)
//   ears      Audio-Intelligence (STT, Embeddings, Klassifikation, Audio-LLM)
//   voiceGen  TTS/Gesang/Song/SFX/Stem-Separation
//
// Die frühere Regel „maximal 1 GPU-Endpoint (`samplemonk-ai`, A100)“ ist damit
// abgelöst: sie war auf den HF-Custom-Container zugeschnitten, in dem alle
// Modelle in EINEM Model Manager mit LRU liefen. Die 3-Rollen-Flotte trennt
// stattdessen nach Intelligenz-Bedarf (Details: docs/RUNPOD_AI_V1_SPEC.md).
//
// Kostenregel bleibt bestehen: mehr als GPU_ROLE_IDS.length Endpoints sind
// verboten – jedes zusätzliche Endpoint ist eine zusätzliche Cold-Start-Fläche
// und, sobald warm gehalten, eine zusätzliche Dauerlast.
// ============================================================================

/** Kanonische Rollen der GPU-Flotte – Reihenfolge = Anzeige-Reihenfolge. */
export const GPU_ROLE_IDS = ['brain', 'ears', 'voiceGen'] as const;

/** Rolle eines GPU-Endpoints. */
export type GpuRoleId = (typeof GPU_ROLE_IDS)[number];

/** Harte Obergrenze aktiver GPU-Endpoints (Kostenregel). */
export const AI_MAX_GPU_ENDPOINTS = (typeof process !== 'undefined' && process.env)
  ? Number(process.env.AI_MAX_GPU_ENDPOINTS ?? GPU_ROLE_IDS.length)
  : GPU_ROLE_IDS.length;

/**
 * Alt-Endpoints, die NICHT mehr verwendet werden dürfen (nur Doku/Status).
 * `samplemonk-ai` war der gemeinsame HF-Custom-Container, die übrigen die
 * abgeschalteten HF-Pilot-/CLAP-Endpoints.
 */
export const LEGACY_GPU_ENDPOINTS = [
  'samplemonk-ai',
  'samplemonk-ai-pilot',
  'samplemonk-ai-clap',
] as const;

/** Namenskonvention der RunPod-Serverless-Endpoints je Rolle. */
export function endpointNameForRole(role: GpuRoleId): string {
  return `samplemonk-ai-${role === 'voiceGen' ? 'voice' : role}`;
}

/**
 * Verhindert versehentlich konfigurierte GPU-Infrastruktur jenseits der drei
 * Rollen. Wird beim Start des Provider-Routers aufgerufen.
 */
export function assertGpuEndpointBudget(): void {
  const max = AI_MAX_GPU_ENDPOINTS;
  if (!Number.isInteger(max) || max < 1 || max > GPU_ROLE_IDS.length) {
    throw new Error(
      `AI_MAX_GPU_ENDPOINTS muss zwischen 1 und ${GPU_ROLE_IDS.length} liegen (aktuell: ${AI_MAX_GPU_ENDPOINTS}). ` +
        `Die AI-Flotte besteht aus den Rollen ${GPU_ROLE_IDS.join(', ')} – weitere GPU-Endpoints sind nicht erlaubt.`,
    );
  }
}
