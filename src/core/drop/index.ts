/**
 * dropMONK – Core Drop Engine
 * ==========================
 * Zentrale Exports für Drop Engine Core
 */

// Types & Constants
export * from './types/DropProfile';

// Core Services
export { DropContextAnalyzer, dropContextAnalyzer } from './DropContextAnalyzer';
export type { AudioContext, MixerChannel, SuggestionScoring } from './DropContextAnalyzer';

export { AiDropGenerator, aiDropGenerator } from './AiDropGenerator';
export type { AiDropRequest } from './AiDropGenerator';

export { DropEngine, dropEngine } from './DropEngine';
export type { DropExecution, ParameterAnimation, DropEngineEvents } from './DropEngine';

export { DropPresetStore, dropPresetStore } from './DropPresetStore';

// Phase 3 Bridges
export { MixerBridge, mixerBridge } from './MixerBridge';
export type { MixerChannelState } from './MixerBridge';

export { PluginParameterBridge, pluginParameterBridge } from './PluginParameterBridge';
export type { ParameterSpec } from './PluginParameterBridge';

export { AiServerBridge, aiServerBridge } from './AiServerBridge';
export type { AiGenerationRequest, AiGenerationResponse } from './AiServerBridge';

export { ClockBridge, clockBridge } from './ClockBridge';
export type { ClockState, QuantizationLevel } from './ClockBridge';
