/**
 * dropMONK – Plugin Parameter Bridge
 * =================================
 * Schreibt Drop-Parameter-Sequenzen auf die realen Plugin-Parameter.
 * Der eigentliche Write geht über den DropAudioAdapter an die audioEngine;
 * ohne Adapter werden die Werte nur im Registry-State gehalten (Tests/OFF).
 */

import type { ParameterTransformation } from './types/DropProfile';
import { getDropAudioAdapter } from './DropAudioAdapter';

/**
 * Plugin Parameter Registry Entry
 * Describes a parameter's min/max/type
 */
export interface ParameterSpec {
  id: string;
  pluginId: string;
  name: string;
  type: 'number' | 'boolean' | 'enum';
  min: number;
  max: number;
  defaultValue: number;
  unit?: string;
}

/** Parameter, die von den Built-in-Drop-Profilen adressiert werden. */
const BUILT_IN_PARAMETERS: ParameterSpec[] = [
  { id: 'synthesizer:cutoff', pluginId: 'synthesizer', name: 'Filter Cutoff', type: 'number', min: 0, max: 1, defaultValue: 0.5 },
  { id: 'synthesizer:resonance', pluginId: 'synthesizer', name: 'Resonance', type: 'number', min: 0, max: 1, defaultValue: 0.2 },
  { id: 'effect:mix', pluginId: 'effect', name: 'Wet Mix', type: 'number', min: 0, max: 1, defaultValue: 0.3 },
  { id: 'effect:size', pluginId: 'effect', name: 'Room Size / Depth', type: 'number', min: 0, max: 1, defaultValue: 0.4 },
  { id: 'effect:cutoff', pluginId: 'effect', name: 'FX Filter Cutoff', type: 'number', min: 0, max: 1, defaultValue: 0.5 },
  { id: 'effect:feedback', pluginId: 'effect', name: 'Feedback', type: 'number', min: 0, max: 1, defaultValue: 0.3 },
  { id: 'drum:drive', pluginId: 'drum', name: 'Drive/Saturation', type: 'number', min: 0, max: 1, defaultValue: 0 },
  { id: 'drum:density', pluginId: 'drum', name: 'Pattern Density', type: 'number', min: 0, max: 1, defaultValue: 0.5 },
  { id: 'drum:cymbal_level', pluginId: 'drum', name: 'Cymbal Level', type: 'number', min: 0, max: 1, defaultValue: 0.5 },
  { id: 'drum:pan', pluginId: 'drum', name: 'Pan', type: 'number', min: -1, max: 1, defaultValue: 0 },
  { id: 'mixer:bass_gain', pluginId: 'mixer', name: 'Bass Gain', type: 'number', min: 0, max: 1, defaultValue: 0.8 },
  { id: 'mixer:channel_fade', pluginId: 'mixer', name: 'Channel Fade', type: 'number', min: 0, max: 1, defaultValue: 1 },
  { id: 'dsp:drive', pluginId: 'dsp', name: 'DSP Drive', type: 'number', min: 0, max: 1, defaultValue: 0.2 },
  { id: 'dsp:resonance', pluginId: 'dsp', name: 'DSP Resonance', type: 'number', min: 0, max: 1, defaultValue: 0.2 },
  { id: 'dsp:depth', pluginId: 'dsp', name: 'DSP Depth', type: 'number', min: 0, max: 1, defaultValue: 0.3 },
  { id: 'mastering:makeup', pluginId: 'mastering', name: 'Makeup Gain', type: 'number', min: 0, max: 1, defaultValue: 0.5 },
];

/**
 * Plugin Parameter Bridge
 * Maps drop profile parameters to actual plugin controls
 */
export class PluginParameterBridge {
  private parameterRegistry: Map<string, ParameterSpec> = new Map();
  private lastValues: Map<string, number> = new Map();

  constructor() {
    this.initializeRegistry();
  }

  /**
   * Registry mit den Built-in-Parametern füllen.
   * Weitere Parameter können über registerParameter() aus den Plugins
   * nachgemeldet werden (Discovery zur Laufzeit).
   */
  private initializeRegistry(): void {
    for (const spec of BUILT_IN_PARAMETERS) {
      this.registerParameter(spec);
    }
  }

  /**
   * Register a parameter
   */
  registerParameter(spec: ParameterSpec): void {
    this.parameterRegistry.set(spec.id, spec);
  }

  /**
   * Parameter eines Plugins auflisten
   */
  discoverParameters(pluginId: string): ParameterSpec[] {
    return Array.from(this.parameterRegistry.values()).filter((p) => p.pluginId === pluginId);
  }

  /**
   * Parameter setzen. `value` ist bereits auf den Spec-Bereich skaliert.
   * Rückgabe: tatsächlich geschriebener (geclampter) Wert oder null.
   */
  setParameter(parameterId: string, value: number): number | null {
    const spec = this.parameterRegistry.get(parameterId);
    if (!spec) {
      console.error(`Parameter not found: ${parameterId}`);
      return null;
    }

    if (!Number.isFinite(value)) return null;

    const clampedValue = Math.max(spec.min, Math.min(spec.max, value));
    this.lastValues.set(parameterId, clampedValue);

    const adapter = getDropAudioAdapter();
    if (adapter) {
      const [pluginId, paramName] = parameterId.split(':');
      try {
        adapter.setPluginParameter(pluginId, paramName, clampedValue);
      } catch (err) {
        console.error(`Parameter write failed for ${parameterId}:`, err);
      }
    }

    return clampedValue;
  }

  /**
   * Normalisierten Wert (0..1) auf den Spec-Bereich skalieren und schreiben.
   */
  setNormalizedParameter(parameterId: string, normalized: number): number | null {
    const spec = this.parameterRegistry.get(parameterId);
    if (!spec) {
      console.warn(`Unknown parameter: ${parameterId}`);
      return null;
    }
    const n = Math.max(0, Math.min(1, normalized));
    return this.setParameter(parameterId, spec.min + (spec.max - spec.min) * n);
  }

  /** Zuletzt geschriebener Wert (Diagnose/Tests). */
  getLastValue(parameterId: string): number | undefined {
    return this.lastValues.get(parameterId);
  }

  /**
   * Apply parameter transformation envelope
   */
  async applyEnvelope(
    parameterId: string,
    envelope: (progress: number) => number,
    duration: number = 4000
  ): Promise<void> {
    const spec = this.parameterRegistry.get(parameterId);
    if (!spec) {
      console.error(`Parameter not found: ${parameterId}`);
      return;
    }

    const steps = Math.max(1, Math.ceil(duration / 16.67)); // ~60fps
    const stepDuration = duration / steps;

    for (let i = 0; i <= steps; i++) {
      const progress = i / steps;
      this.setNormalizedParameter(parameterId, envelope(progress));

      if (i < steps && stepDuration > 0) {
        await new Promise((resolve) => setTimeout(resolve, stepDuration));
      }
    }
  }

  /**
   * Validate parameter transformation against registry
   */
  validateTransformation(transform: ParameterTransformation): boolean {
    const parameterId = `${transform.pluginId}:${transform.parameterId}`;
    const spec = this.parameterRegistry.get(parameterId);

    if (!spec) {
      console.warn(`Unknown parameter: ${parameterId}`);
      return false;
    }

    // Check value ranges
    if (transform.startValue < 0 || transform.startValue > 1) {
      console.warn(`Invalid startValue for ${parameterId}: ${transform.startValue}`);
      return false;
    }

    if (transform.endValue < 0 || transform.endValue > 1) {
      console.warn(`Invalid endValue for ${parameterId}: ${transform.endValue}`);
      return false;
    }

    return true;
  }

  /**
   * Get parameter spec
   */
  getParameterSpec(parameterId: string): ParameterSpec | undefined {
    return this.parameterRegistry.get(parameterId);
  }

  /**
   * List all registered parameters
   */
  getAllParameters(): ParameterSpec[] {
    return Array.from(this.parameterRegistry.values());
  }
}

export const pluginParameterBridge = new PluginParameterBridge();
