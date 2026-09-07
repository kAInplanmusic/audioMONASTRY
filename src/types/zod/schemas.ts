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
