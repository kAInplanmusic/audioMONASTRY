// ============================================================================
// AI-Infrastruktur-Kostenregel: MAXIMAL 1 GPU (A100) gleichzeitig für SampleMONK
// ----------------------------------------------------------------------------
// Alle Modelle/Services laufen auf EINEM HF-Endpoint (`samplemonk-ai`), der im
// Custom Container `services/samplemonk-ai-runtime` den gemeinsamen Model
// Manager nutzt. Separate GPU-Endpoints (pilot/clap) sind deaktiviert.
// ============================================================================

/** Harte Obergrenze aktiver GPU-Endpoints (Kostenregel). */
export const AI_MAX_GPU_ENDPOINTS = Number(process.env.AI_MAX_GPU_ENDPOINTS ?? 1);

/** Einziger erlaubter HF-Endpoint-Name für GPU-Inferenz. */
export const SINGLE_GPU_ENDPOINT_NAME = 'samplemonk-ai';

/** Names von alten, zu deaktivierenden GPU-Endpoints (nur Doku/Status). */
export const LEGACY_GPU_ENDPOINTS = ['samplemonk-ai-pilot', 'samplemonk-ai-clap'] as const;

/**
 * Verhindert versehentlich konfigurierte Mehrfach-GPU-Infrastruktur.
 * Wird beim Start des Provider-Routers aufgerufen.
 */
export function assertSingleGpuEndpoint(): void {
  if (AI_MAX_GPU_ENDPOINTS !== 1) {
    throw new Error(
      `AI_MAX_GPU_ENDPOINTS muss 1 sein (aktuell: ${AI_MAX_GPU_ENDPOINTS}). ` +
      'SampleMONK darf maximal 1 A100 gleichzeitig verwenden – alle Modelle laufen auf samplemonk-ai.',
    );
  }
}
