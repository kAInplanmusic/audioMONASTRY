/**
 * Zod-Schemas für Socket-IO-Events & Peer-Payloads
 * (Typ-Complete Replacement für any in WebRTCManager/Collab)
 * Stand: 2026-09-07
 */

import { z } from 'zod';

// ============================================================================
// Session-Payloads
// ============================================================================

const SessionPeerSchema = z.object({
  socketId: z.string(),
  userId: z.string(),
});

const SessionMembersPayloadSchema = z.object({
  members: z.array(SessionPeerSchema),
});

const RoleChangedPayloadSchema = z.object({
  socketId: z.string(),
  oldRole: z.string(),
  newRole: z.enum(['USER', 'ADMIN']),
});

const SessionFullPayloadSchema = z.object({
  message: z.string().optional(),
});

const PeerJoinedPayloadSchema = z.object({
  socketId: z.string(),
  userId: z.string(),
});

const PeerLeftPayloadSchema = z.object({
  socketId: z.string(),
  userId: z.string(),
});

const PluginStatePayloadSchema = z.object({
  pluginId: z.string(),
  state: z.enum(['OFF', 'AUTO_AI', 'LOCKED']),
  userId: z.string(),
});

// ============================================================================
// Audio-HRTF-Processing
// ============================================================================

export const HRTFProcessingResultSchema = z.object({
  success: z.boolean(),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
});

// ============================================================================
// Server-API-Payloads (ARCH-SEC-003 – Runtime Validation statt as-Casts)
// ============================================================================

const UPLOAD_KEY_RE = /^uploads\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/;

const TelemetryEventSchema = z.object({
  type: z.string().trim().min(1).max(32).default('log'),
  source: z.string().trim().min(1).max(128).default('client'),
  message: z.string().trim().max(1000).default(''),
  context: z.unknown().optional(),
  ts: z.number().finite().optional(),
});

export const TelemetryPayloadSchema = z.object({
  events: z.array(TelemetryEventSchema).max(50),
});

export const CloudSampleSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  category: z.enum(['bass', 'mids', 'highs']),
  type: z.string().trim().min(1).max(64),
  url: z.string().trim().max(2000).optional(),
  description: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim().max(100)).max(50).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export const CloudMusicSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  artist: z.string().trim().max(200).optional(),
  url: z.string().trim().min(1).max(2000),
  bpm: z.number().finite().min(20).max(300).optional(),
});

export const CloudUploadJsonSchema = z.object({
  key: z.string().regex(UPLOAD_KEY_RE, 'invalid key (nur uploads/<dateiname> erlaubt)'),
  dataBase64: z.string().min(1),
  contentType: z.string().trim().max(100).optional(),
});

export const AiPromptSchema = z.object({
  prompt: z.string().trim().max(4000).optional(),
});

export const AiCompleteSchema = z.object({
  prompt: z.string().trim().min(1).max(8000),
  complexity: z.enum(['simple', 'moderate', 'complex']).optional(),
  maxTokens: z.number().finite().int().min(64).max(4096).optional(),
  temperature: z.number().finite().min(0).max(2).optional(),
  reasoningEffort: z.enum(['low', 'high', 'max']).optional(),
});

export const AiGenerateDropSchema = z
  .object({
    userPrompt: z.string().trim().max(2000).optional(),
    prompt: z.string().trim().max(2000).optional(),
    context: z
      .object({
        bpm: z.number().finite().min(40).max(220).optional(),
        activePlugins: z.array(z.unknown()).max(20).optional(),
        currentEnergy: z.number().finite().min(0).max(1).optional(),
      })
      .optional(),
    style: z.enum(['subtle', 'moderate', 'extreme']).optional(),
    duration: z.number().finite().min(100).max(32000).optional(),
  })
  .refine((v) => Boolean(v.userPrompt?.trim() || v.prompt?.trim()), {
    message: 'userPrompt fehlt',
    path: ['userPrompt'],
  });

export const AiVisionSchema = z.object({
  prompt: z.string().trim().min(1).max(1200),
  style: z
    .enum([
      'realism', 'abstract', 'noir', 'comic', 'psychedelic', 'industrial',
      'cosmic', 'fantasy', 'dystopia', 'geometry', 'liquid', 'fire',
    ])
    .optional(),
  bpm: z.number().finite().min(40).max(220).optional(),
  energy: z.number().finite().min(0).max(1).optional(),
  moodTags: z.array(z.string().trim().max(40)).max(8).optional(),
  steps: z.number().finite().int().min(1).max(50).optional(),
  width: z.number().finite().int().min(256).max(1536).optional(),
  height: z.number().finite().int().min(256).max(1536).optional(),
});

export const AiVideoSchema = z
  .object({
    imageBase64: z.string().trim().min(100).max(20_000_000).optional(),
    imageUrl: z.string().trim().url().max(2000).optional(),
    prompt: z.string().trim().max(1200).optional(),
    negativePrompt: z.string().trim().max(500).optional(),
    steps: z.number().finite().int().min(2).max(30).optional(),
    width: z.number().finite().int().min(256).max(1280).optional(),
    height: z.number().finite().int().min(256).max(1280).optional(),
    cfg: z.number().finite().min(1).max(10).optional(),
    seed: z.number().finite().int().min(0).max(2_000_000_000).optional(),
  })
  .refine((v) => Boolean(v.imageBase64 || v.imageUrl), { message: 'imageBase64 oder imageUrl erforderlich' });

export const AiVisionFeedbackSchema = z.object({
  generationId: z.string().trim().min(1).max(64),
  rating: z.number().finite().int().min(1).max(5),
  keep: z.boolean().optional(),
  tags: z.array(z.string().trim().max(40)).max(8).optional(),
  comment: z.string().trim().max(500).optional(),
});

/**
 * VisualMONK: Text→Clip in einem Aufruf (FLUX-Bild → Wan2.2-Bewegung).
 * Der Stil-Enum ist derselbe wie beim Bild (`AiVisionSchema`), damit UI,
 * Prompt-Bau und Validierung nicht auseinanderlaufen.
 */
export const AiVideoClipSchema = z.object({
  prompt: z.string().trim().min(1).max(1200),
  motion: z.string().trim().max(500).optional(),
  style: AiVisionSchema.shape.style,
  bpm: z.number().finite().min(40).max(220).optional(),
  energy: z.number().finite().min(0).max(1).optional(),
  moodTags: z.array(z.string().trim().max(40)).max(8).optional(),
  imageSteps: z.number().finite().int().min(1).max(50).optional(),
  videoSteps: z.number().finite().int().min(2).max(30).optional(),
  width: z.number().finite().int().min(256).max(1536).optional(),
  height: z.number().finite().int().min(256).max(1536).optional(),
  videoWidth: z.number().finite().int().min(256).max(1280).optional(),
  videoHeight: z.number().finite().int().min(256).max(1280).optional(),
  seed: z.number().finite().int().min(0).max(2_000_000_000).optional(),
  negativePrompt: z.string().trim().max(500).optional(),
});

/**
 * VisualMONK: Show zusammenführen (mehrere Clips → ein mp4).
 * Ein Clip kommt entweder als `dataUri` (direkt aus der App) oder als `url`
 * (R2 bzw. lokaler Artefakt-Pfad des Servers). Bewusst begrenzt: 10 Clips und
 * ~3 MB je Clip passen in das 50-MB-JSON-Limit des Servers.
 */
export const AiShowMergeSchema = z.object({
  clips: z
    .array(
      z
        .object({
          url: z.string().trim().max(2000).optional(),
          dataUri: z.string().trim().min(100).max(4_000_000).optional(),
          label: z.string().trim().max(80).optional(),
        })
        .refine((c) => Boolean(c.url || c.dataUri), { message: 'url oder dataUri erforderlich' }),
    )
    .min(1)
    .max(10),
  width: z.number().finite().int().min(256).max(1920).optional(),
  height: z.number().finite().int().min(256).max(1920).optional(),
  fps: z.number().finite().int().min(12).max(60).optional(),
});

/**
 * VisualMONK RAG: Query-Parameter für den Stil-Vorschlag (`GET /api/ai/vision/styles`).
 * Query-Strings sind externer Input → `coerce` (Zahl aus String), geklemmt.
 */
export const AiVisionStylesQuerySchema = z.object({
  energy: z.coerce.number().finite().min(0).max(1).optional(),
  bpm: z.coerce.number().finite().min(40).max(220).optional(),
  limit: z.coerce.number().finite().int().min(1).max(50).optional(),
});

// ---------------------------------------------------------------------------
// SEC-P1-001: Validierung der restlichen externen Payloads.
// Grundsatz hier: **Typen und Obergrenzen** prüfen, aber die fachlichen
// Kürzungen/Meldungen der Routen unangetastet lassen. So wird Typ-Verwirrung
// (`text: {...}`) und absurd große Eingabe abgewiesen, ohne dass sich das
// Verhalten für gültige Clients ändert (z. B. kürzt `cleanVoiceText` weiter
// selbst auf 500 Zeichen — das Schema lässt bewusst mehr zu).
// ---------------------------------------------------------------------------

/** POST /api/generate-voice – lokaler Voice-Stub. */
export const GenerateVoiceSchema = z.object({
  text: z.string().max(4000).optional(),
  voicePreset: z.string().trim().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
});

/** POST /api/voice/tts – Text zu Stimme. */
export const VoiceTtsSchema = z.object({
  text: z.string().max(4000).optional(),
  model: z.string().trim().max(200).optional(),
  language: z.string().trim().max(40).optional(),
  speaker: z.string().trim().max(200).optional(),
  instruct: z.string().trim().max(2000).optional(),
});

/** POST /api/voice/sing – Text zu Gesang. */
export const VoiceSingSchema = z.object({
  text: z.string().max(4000).optional(),
  model: z.string().trim().max(200).optional(),
});

/** POST /api/voice/song – Prompt zu Song (Dauer klemmt die Route selbst auf 1..30 s). */
export const VoiceSongSchema = z.object({
  prompt: z.string().max(4000).optional(),
  model: z.string().trim().max(200).optional(),
  durationSeconds: z.coerce.number().finite().min(1).max(300).optional(),
  style: z.string().trim().max(200).optional(),
  bpm: z.coerce.number().finite().min(20).max(400).optional(),
});

/** POST /api/library/search – semantische Bibliotheks-Suche. */
export const LibrarySearchSchema = z.object({
  query: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/**
 * POST /api/ai/mcp/tools/:name – Argumente eines MCP-Tools.
 * Die Tools haben eigene Argument-Schemata, deshalb hier bewusst nur die
 * **Hülle**: Objekt mit begrenzten Schlüsseln und begrenzter Gesamtgröße.
 */
export const McpToolInvokeSchema = z
  .record(z.string().trim().min(1).max(64), z.unknown())
  .refine((v) => JSON.stringify(v ?? {}).length <= 20_000, { message: 'Argumente zu gross (max 20 kB)' });

/** POST /api/alerts/webhook – Alertmanager-Webhook (Discord/Slack/Telegram). */
export const AlertsWebhookSchema = z.object({
  alerts: z
    .array(
      z.object({
        status: z.string().trim().max(20).optional(),
        labels: z.record(z.string().max(100), z.string().max(500)).optional(),
        annotations: z.record(z.string().max(100), z.string().max(2000)).optional(),
        startsAt: z.string().trim().max(40).optional(),
        endsAt: z.string().trim().max(40).optional(),
      }),
    )
    .max(100)
    .optional(),
});

/** POST /api/sound/generate – Einzel-Sound (Kick, Snare, Atmos …). */
export const SoundGenerateSchema = z.object({
  kind: z.string().trim().max(40).optional(),
  prompt: z.string().max(4000).optional(),
  durationSeconds: z.coerce.number().finite().min(1).max(300).optional(),
});

/**
 * Weiterleitungs-Routen (`/api/master/*`): Der Body geht unverändert an den
 * master-player-Service. Dort gibt es (Stand 2026-09-11) keine Validierung,
 * deshalb wird hier wenigstens die Hülle begrenzt: Objekt mit kurzen Schlüsseln
 * und gedeckelter Gesamtgröße.
 */
export function boundedJsonObjectSchema(maxBytes: number, message: string) {
  return z
    .record(z.string().trim().min(1).max(64), z.unknown())
    .refine((v) => JSON.stringify(v ?? {}).length <= maxBytes, { message });
}

/** Gedeckelter JSON-Objekt-Body für Proxy-Routen (256 kB). */
export const JsonObjectBodySchema = boundedJsonObjectSchema(262_144, 'Payload zu gross (max 256 kB)');

export const AiOrchestrateSchema = z.object({
  userId: z.string().trim().max(64).optional(),
  task: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(200),
  input: z.unknown().optional(),
  sessionId: z.string().trim().max(128).optional(),
});

export const PluginLockSocketSchema = z.object({
  pluginId: z.string().trim().min(1).max(64),
});

export const PluginStateSocketSchema = z.object({
  pluginId: z.string().trim().min(1).max(64),
  state: z.enum(['OFF', 'AUTO_AI', 'PRO', 'LOCKED']),
});

// ============================================================================
// Type Exports
// ============================================================================

export type SessionPeer = z.infer<typeof SessionPeerSchema>;
type SessionMembersPayload = z.infer<typeof SessionMembersPayloadSchema>;
type RoleChangedPayload = z.infer<typeof RoleChangedPayloadSchema>;
type SessionFullPayload = z.infer<typeof SessionFullPayloadSchema>;
type PeerJoinedPayload = z.infer<typeof PeerJoinedPayloadSchema>;
type PeerLeftPayload = z.infer<typeof PeerLeftPayloadSchema>;
type PluginStatePayload = z.infer<typeof PluginStatePayloadSchema>;
export type HRTFProcessingResult = z.infer<typeof HRTFProcessingResultSchema>;

// ============================================================================
// Validation Helpers
// ============================================================================

export function validateSessionMembers(data: unknown): SessionMembersPayload {
  return SessionMembersPayloadSchema.parse(data);
}

export function validateRoleChanged(data: unknown): RoleChangedPayload {
  return RoleChangedPayloadSchema.parse(data);
}

export function validatePeerJoined(data: unknown): PeerJoinedPayload {
  return PeerJoinedPayloadSchema.parse(data);
}

export function validatePeerLeft(data: unknown): PeerLeftPayload {
  return PeerLeftPayloadSchema.parse(data);
}

export function validatePluginState(data: unknown): PluginStatePayload {
  return PluginStatePayloadSchema.parse(data);
}

export function validateSessionFull(data: unknown): SessionFullPayload {
  return SessionFullPayloadSchema.parse(data);
}
