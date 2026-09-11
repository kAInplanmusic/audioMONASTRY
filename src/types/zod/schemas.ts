/**
 * Zod-Schemas für Socket-IO-Events & Peer-Payloads
 * (Typ-Complete Replacement für any in WebRTCManager/Collab)
 * Stand: 2026-09-07
 */

import { z } from 'zod';

// ============================================================================
// Session-Payloads
// ============================================================================

export const SessionPeerSchema = z.object({
  socketId: z.string(),
  userId: z.string(),
});

export const SessionMembersPayloadSchema = z.object({
  members: z.array(SessionPeerSchema),
});

export const RoleChangedPayloadSchema = z.object({
  socketId: z.string(),
  oldRole: z.string(),
  newRole: z.enum(['USER', 'ADMIN']),
});

export const SessionFullPayloadSchema = z.object({
  message: z.string().optional(),
});

export const PeerJoinedPayloadSchema = z.object({
  socketId: z.string(),
  userId: z.string(),
});

export const PeerLeftPayloadSchema = z.object({
  socketId: z.string(),
  userId: z.string(),
});

export const PluginStatePayloadSchema = z.object({
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

export const TelemetryEventSchema = z.object({
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

export const AiVisionFeedbackSchema = z.object({
  generationId: z.string().trim().min(1).max(64),
  rating: z.number().finite().int().min(1).max(5),
  keep: z.boolean().optional(),
  tags: z.array(z.string().trim().max(40)).max(8).optional(),
  comment: z.string().trim().max(500).optional(),
});

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
export type SessionMembersPayload = z.infer<typeof SessionMembersPayloadSchema>;
export type RoleChangedPayload = z.infer<typeof RoleChangedPayloadSchema>;
export type SessionFullPayload = z.infer<typeof SessionFullPayloadSchema>;
export type PeerJoinedPayload = z.infer<typeof PeerJoinedPayloadSchema>;
export type PeerLeftPayload = z.infer<typeof PeerLeftPayloadSchema>;
export type PluginStatePayload = z.infer<typeof PluginStatePayloadSchema>;
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
