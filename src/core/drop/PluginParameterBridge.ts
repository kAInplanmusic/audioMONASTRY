/**
 * dropMONK – Plugin Parameter Bridge
 * =================================
 * Connect drop parameter sequences to plugin instances
 */

import type { ParameterTransformation } from '../drop/types/DropProfile';

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

/**
 * Plugin Parameter Bridge
 * Maps drop profile parameters to actual plugin controls
 */
export class PluginParameterBridge {
  private parameterRegistry: Map<string, ParameterSpec> = new Map();

  constructor() {
    this.initializeRegistry();
  }

  /**
   * Initialize parameter registry
   * TODO: Discover plugins from audioEngine + expose their parameters
   */
  private initializeRegistry(): void {
    // Placeholder: will be populated from audioEngine.discoverPlugins()
    // For now, register common parameters
    this.registerParameter({
      id: 'synth:cutoff',
      pluginId: 'synthesizer',
      name: 'Filter Cutoff',
      type: 'number',
      min: 0,
      max: 1,
      defaultValue: 0.5,
      unit: 'Hz',
    });

    this.registerParameter({
      id: 'synth:resonance',
      pluginId: 'synthesizer',
      name: 'Resonance',
      type: 'number',
      min: 0,
      max: 1,
      defaultValue: 0.2,
    });

    this.registerParameter({
      id: 'reverb:mix',
      pluginId: 'reverb',
      name: 'Wet Mix',
      type: 'number',
      min: 0,
      max: 1,
      defaultValue: 0.3,
    });

    this.registerParameter({
      id: 'reverb:decay',
      pluginId: 'reverb',
      name: 'Decay',
      type: 'number',
      min: 0.1,
      max: 5,
      defaultValue: 2,
      unit: 's',
    });

    this.registerParameter({
      id: 'drum:drive',
      pluginId: 'drum',
      name: 'Drive/Saturation',
      type: 'number',
      min: 0,
      max: 1,
      defaultValue: 0,
    });

    this.registerParameter({
      id: 'drum:pan',
      pluginId: 'drum',
      name: 'Pan',
      type: 'number',
      min: -1,
      max: 1,
      defaultValue: 0,
    });
  }

  /**
   * Register a parameter
   */
  registerParameter(spec: ParameterSpec): void {
    this.parameterRegistry.set(spec.id, spec);
  }

  /**
   * Discover parameters from audioEngine
   * TODO: Connect to audioEngine.discoverPlugins()
   */
  discoverParameters(pluginId: string): ParameterSpec[] {
    return Array.from(this.parameterRegistry.values()).filter((p) => p.pluginId === pluginId);
  }

  /**
   * Set plugin parameter
   * TODO: Connect to audioEngine.setPluginParameter()
   */
  setParameter(parameterId: string, value: number): void {
    const spec = this.parameterRegistry.get(parameterId);
    if (!spec) {
      console.error(`Parameter not found: ${parameterId}`);
      return;
    }

    // Clamp value to min/max
    const clampedValue = Math.max(spec.min, Math.min(spec.max, value));

    // TODO: Call audioEngine.setPluginParameter(spec.pluginId, spec.id, clampedValue)
    console.log(
      `[PluginBridge] Set ${parameterId} to ${clampedValue} (${spec.name})`
    );
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

    const steps = Math.ceil(duration / 16.67); // ~60fps
    const stepDuration = duration / steps;

    for (let i = 0; i <= steps; i++) {
      const progress = i / steps;
      const normalizedValue = envelope(progress);
      const scaledValue = spec.min + (spec.max - spec.min) * normalizedValue;

      this.setParameter(parameterId, scaledValue);

      if (i < steps) {
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
