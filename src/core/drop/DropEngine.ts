/**
 * dropMONK – Drop Engine
 * ====================
 * Wende Drop-Parameter-Sequenz auf Plugins an mit Quantisierung & Smoothing
 */

import type { DropProfile, ParameterTransformation, QuantizationType } from './types/DropProfile';
import { interpolateValue } from './types/DropProfile';

export interface ParameterAnimation {
  targetId: string; // plugin_param_id
  envelope: Float32Array | ((progress: number) => number); // Pre-computed oder Runtime-Curve
  startSample: number;
  duration: number;
  startValue: number;
  endValue: number;
}

export interface DropExecution {
  profileId: string;
  startTime: number;
  endTime: number;
  parameterAnimations: ParameterAnimation[];
  isActive: boolean;
  progress: number; // 0..1
}

export interface DropEngineConfig {
  audioSampleRate?: number; // default 48000
  scheduleAheadTime?: number; // ms, default 100
}

export interface DropEngineEvents {
  onDropStarted?: (profileId: string) => void;
  onDropProgress?: (progress: number, profileId: string) => void;
  onDropFinished?: (profileId: string) => void;
  onParameterUpdate?: (pluginId: string, parameterId: string, value: number) => void;
  onError?: (error: Error) => void;
}

/**
 * Drop Engine – Execution
 * Führt Drop-Profile aus und animiert Parameter
 */
export class DropEngine {
  private activeDrops: Map<string, DropExecution> = new Map();
  private animationFrameId: number | null = null;
  private config: Required<DropEngineConfig>;
  private events: DropEngineEvents = {};
  private lastUpdateTime: number = 0;

  constructor(config?: DropEngineConfig) {
    this.config = {
      audioSampleRate: config?.audioSampleRate || 48000,
      scheduleAheadTime: config?.scheduleAheadTime || 100,
    };
  }

  /**
   * Register Event Listeners
   */
  on<K extends keyof DropEngineEvents>(event: K, handler: DropEngineEvents[K]): void {
    this.events[event] = handler;
  }

  /**
   * Trigger Drop mit Modus (immediate oder quantized)
   */
  async triggerDrop(
    profile: DropProfile,
    mode: 'immediate' | 'quantized' = 'immediate',
    quantization?: QuantizationType,
    startTime?: number
  ): Promise<void> {
    try {
      if (mode === 'immediate') {
        this.executeDrop(profile, startTime || Date.now());
      } else if (mode === 'quantized' && quantization) {
        // TODO: Nutze masterClock + QuantizedScheduler
        // Für MVP: Simple Verzögerung
        const delay = this.calculateQuantizationDelay(quantization);
        setTimeout(() => this.executeDrop(profile, Date.now()), delay);
      }
    } catch (err) {
      if (this.events.onError) {
        this.events.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /**
   * Execute Drop sofort
   */
  private executeDrop(profile: DropProfile, startTime: number): void {
    const endTime = startTime + profile.dropDuration;

    // Baue Parameter-Animationen
    const animations = this.buildParameterAnimations(profile, startTime);

    const execution: DropExecution = {
      profileId: profile.id,
      startTime,
      endTime,
      parameterAnimations: animations,
      isActive: true,
      progress: 0,
    };

    // Speichern
    const executionId = `${profile.id}_${startTime}`;
    this.activeDrops.set(executionId, execution);

    // Event
    if (this.events.onDropStarted) {
      this.events.onDropStarted(profile.id);
    }

    // Start Animation Loop
    this.ensureAnimationLoop();
  }

  /**
   * Baue Parameter-Animationen aus Profile
   */
  private buildParameterAnimations(
    profile: DropProfile,
    startTime: number
  ): ParameterAnimation[] {
    const animations: ParameterAnimation[] = [];

    for (const transform of profile.parameterSequence) {
      const paramStartTime = startTime + (transform.delay || 0);
      const paramDuration = transform.duration;

      const animation: ParameterAnimation = {
        targetId: `${transform.pluginId}:${transform.parameterId}`,
        envelope: (progress: number) => {
          return interpolateValue(
            transform.startValue,
            transform.endValue,
            progress,
            transform.curve
          );
        },
        startSample: (paramStartTime * this.config.audioSampleRate) / 1000,
        duration: (paramDuration * this.config.audioSampleRate) / 1000,
        startValue: transform.startValue,
        endValue: transform.endValue,
      };

      animations.push(animation);
    }

    return animations;
  }

  /**
   * Animation Loop – Update alle aktiven Drops
   */
  private ensureAnimationLoop(): void {
    if (this.animationFrameId !== null) return;

    const loop = () => {
      const now = Date.now();
      const deltaTime = now - this.lastUpdateTime;
      this.lastUpdateTime = now;

      this.updateActiveDrops(now);

      if (this.activeDrops.size > 0) {
        this.animationFrameId = requestAnimationFrame(loop);
      } else {
        this.animationFrameId = null;
      }
    };

    this.animationFrameId = requestAnimationFrame(loop);
  }

  /**
   * Update alle aktiven Drops
   */
  private updateActiveDrops(now: number): void {
    const completed: string[] = [];

    for (const [id, execution] of this.activeDrops.entries()) {
      if (now >= execution.endTime) {
        // Drop fertig
        completed.push(id);
        execution.progress = 1;

        // Finale Parameter-Updates
        for (const anim of execution.parameterAnimations) {
          this.applyParameterAnimation(anim, 1.0);
        }

        if (this.events.onDropFinished) {
          this.events.onDropFinished(execution.profileId);
        }
      } else if (now >= execution.startTime) {
        // Drop läuft
        execution.progress = (now - execution.startTime) / (execution.endTime - execution.startTime);

        // Update alle Animationen
        for (const anim of execution.parameterAnimations) {
          const animProgress = this.calculateAnimationProgress(
            now,
            anim.startSample,
            anim.duration
          );

          if (animProgress >= 0 && animProgress <= 1) {
            this.applyParameterAnimation(anim, animProgress);
          }
        }

        // Progress Event
        if (this.events.onDropProgress) {
          this.events.onDropProgress(execution.progress, execution.profileId);
        }
      }
    }

    // Entferne abgeschlossene Drops
    for (const id of completed) {
      this.activeDrops.delete(id);
    }
  }

  /**
   * Kalkuliere Animation-Progress (0..1)
   */
  private calculateAnimationProgress(
    now: number,
    startSample: number,
    durationSamples: number
  ): number {
    const currentSample = (now * this.config.audioSampleRate) / 1000;
    const relativePosition = currentSample - startSample;

    if (relativePosition < 0) return -1; // Not started
    if (relativePosition > durationSamples) return 1.1; // Finished

    return relativePosition / durationSamples;
  }

  /**
   * Apply Parameter Animation
   * Ruft onParameterUpdate Callback auf
   */
  private applyParameterAnimation(anim: ParameterAnimation, progress: number): void {
    const value = typeof anim.envelope === 'function' ? anim.envelope(progress) : 0.5;

    const [pluginId, parameterId] = anim.targetId.split(':');

    if (this.events.onParameterUpdate) {
      this.events.onParameterUpdate(pluginId, parameterId, value);
    }
  }

  /**
   * DJ Transition: von Channel A zu Channel B
   */
  async triggerChannelTransition(
    fromChannelId: string,
    toChannelId: string,
    transitionProfile: DropProfile
  ): Promise<void> {
    // Sequenz:
    // 1. Current Channel fade-out (mit fromChannel Parameter)
    // 2. DROP execute
    // 3. New Channel fade-in

    // TODO: Nutze Mixer-Bridge für Fader-Automation
    // Für MVP: Nur Drop-Part ausführen

    await this.triggerDrop(transitionProfile, 'immediate');
  }

  /**
   * Kalkuliere Verzögerung für Quantization
   */
  private calculateQuantizationDelay(quantization: QuantizationType): number {
    // Basis: 120 BPM = 500ms pro Beat
    const baseMs = 500;

    switch (quantization) {
      case 'instant':
        return 0;
      case '1/8bar':
        return baseMs * 2;
      case '1/4bar':
        return baseMs * 4;
      case '1/2bar':
        return baseMs * 8;
      case '1bar':
        return baseMs * 16;
      case '2bar':
        return baseMs * 32;
      case '4bar':
        return baseMs * 64;
      default:
        return baseMs * 16;
    }
  }

  /**
   * Stop aktive Drops
   */
  stopAll(): void {
    this.activeDrops.clear();
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Get Status
   */
  getStatus(): {
    activeDrops: number;
    profiles: string[];
  } {
    return {
      activeDrops: this.activeDrops.size,
      profiles: Array.from(this.activeDrops.values()).map((e) => e.profileId),
    };
  }
}

// Export singleton
export const dropEngine = new DropEngine();
