/**
 * dropMONK – Drop Engine
 * ====================
 * Wende Drop-Parameter-Sequenz auf Plugins an mit Quantisierung & Smoothing
 */

import type { DropProfile, ParameterTransformation, QuantizationType } from './types/DropProfile';
import { interpolateValue } from './types/DropProfile';
import { pluginParameterBridge } from './PluginParameterBridge';
import { mixerBridge } from './MixerBridge';
import { clockBridge } from './ClockBridge';
import type { QuantizationLevel } from './ClockBridge';

export interface ParameterAnimation {
  targetId: string; // plugin_param_id
  envelope: (progress: number) => number; // Runtime-Curve (normalisiert 0..1)
  startTime: number; // absolute ms (Date.now-Basis)
  duration: number; // ms
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
  /** Parameter direkt über die PluginParameterBridge schreiben (default true). */
  applyParameters?: boolean;
}

export interface DropEngineEvents {
  onDropStarted?: (profileId: string) => void;
  onDropProgress?: (progress: number, profileId: string) => void;
  onDropFinished?: (profileId: string) => void;
  onParameterUpdate?: (pluginId: string, parameterId: string, value: number) => void;
  onError?: (error: Error) => void;
}

/** Mapping der Profil-Quantisierung auf die Clock-Raster. */
const QUANTIZATION_MAP: Record<Exclude<QuantizationType, 'instant'>, QuantizationLevel> = {
  '1/8bar': '1beat',
  '1/4bar': '1beat',
  '1/2bar': '2beat',
  '1bar': '1bar',
  '2bar': '2bar',
  '4bar': '4bar',
};

/** rAF mit Node-Fallback (Tests/SSR laufen ohne Browser-Loop). */
const requestFrame = (cb: () => void): number => {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => cb());
  return setTimeout(cb, 16) as unknown as number;
};

const cancelFrame = (id: number): void => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
};

/**
 * Drop Engine – Execution
 * Führt Drop-Profile aus und animiert Parameter
 */
export class DropEngine {
  private activeDrops: Map<string, DropExecution> = new Map();
  private animationFrameId: number | null = null;
  private config: Required<DropEngineConfig>;
  private events: DropEngineEvents = {};
  private pendingScheduleIds: string[] = [];

  constructor(config?: DropEngineConfig) {
    this.config = {
      audioSampleRate: config?.audioSampleRate || 48000,
      scheduleAheadTime: config?.scheduleAheadTime || 100,
      applyParameters: config?.applyParameters ?? true,
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
      const quant = quantization ?? profile.quantization;

      if (mode === 'immediate' || quant === 'instant') {
        this.executeDrop(profile, startTime || Date.now());
        return;
      }

      const level = QUANTIZATION_MAP[quant as Exclude<QuantizationType, 'instant'>] ?? '4bar';
      const clock = clockBridge.getClockState();

      if (clock.isRunning) {
        // Taktgenaue Ausführung über die Master-Clock
        const scheduleId = clockBridge.scheduleDrop(() => {
          this.pendingScheduleIds = this.pendingScheduleIds.filter((id) => id !== scheduleId);
          this.executeDrop(profile, Date.now());
        }, level);
        this.pendingScheduleIds.push(scheduleId);
        return;
      }

      // Transport steht: Fallback über die reale BPM (kein 120-BPM-Hardcode)
      const delay = this.calculateQuantizationDelay(quant);
      setTimeout(() => this.executeDrop(profile, Date.now()), delay);
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
    const animations = this.buildParameterAnimations(profile, startTime);

    // Drop endet, wenn die letzte Parameterfahrt beendet ist.
    const animationEnd = animations.reduce(
      (max, anim) => Math.max(max, anim.startTime + anim.duration),
      startTime + profile.dropDuration
    );

    const execution: DropExecution = {
      profileId: profile.id,
      startTime,
      endTime: animationEnd,
      parameterAnimations: animations,
      isActive: true,
      progress: 0,
    };

    const executionId = `${profile.id}_${startTime}`;
    this.activeDrops.set(executionId, execution);

    if (this.events.onDropStarted) {
      this.events.onDropStarted(profile.id);
    }

    // Startwerte sofort setzen (kein Sprung beim ersten Frame)
    for (const anim of animations) {
      if (anim.startTime <= startTime) this.applyParameterAnimation(anim, 0);
    }

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
      animations.push(this.buildAnimation(transform, startTime));
    }

    return animations;
  }

  private buildAnimation(
    transform: ParameterTransformation,
    startTime: number
  ): ParameterAnimation {
    return {
      targetId: `${transform.pluginId}:${transform.parameterId}`,
      envelope: (progress: number) =>
        interpolateValue(transform.startValue, transform.endValue, progress, transform.curve),
      startTime: startTime + (transform.delay || 0),
      duration: Math.max(1, transform.duration),
      startValue: transform.startValue,
      endValue: transform.endValue,
    };
  }

  /**
   * Animation Loop – Update alle aktiven Drops
   */
  private ensureAnimationLoop(): void {
    if (this.animationFrameId !== null) return;

    const loop = () => {
      this.updateActiveDrops(Date.now());

      if (this.activeDrops.size > 0) {
        this.animationFrameId = requestFrame(loop);
      } else {
        this.animationFrameId = null;
      }
    };

    this.animationFrameId = requestFrame(loop);
  }

  /**
   * Update alle aktiven Drops
   */
  updateActiveDrops(now: number): void {
    const completed: string[] = [];

    for (const [id, execution] of this.activeDrops.entries()) {
      if (now >= execution.endTime) {
        completed.push(id);
        execution.progress = 1;
        execution.isActive = false;

        // Finale Parameter-Werte garantiert schreiben
        for (const anim of execution.parameterAnimations) {
          this.applyParameterAnimation(anim, 1);
        }

        if (this.events.onDropFinished) {
          this.events.onDropFinished(execution.profileId);
        }
      } else if (now >= execution.startTime) {
        execution.progress =
          (now - execution.startTime) / Math.max(1, execution.endTime - execution.startTime);

        for (const anim of execution.parameterAnimations) {
          const animProgress = this.calculateAnimationProgress(now, anim);
          if (animProgress >= 0 && animProgress <= 1) {
            this.applyParameterAnimation(anim, animProgress);
          }
        }

        if (this.events.onDropProgress) {
          this.events.onDropProgress(execution.progress, execution.profileId);
        }
      }
    }

    for (const id of completed) {
      this.activeDrops.delete(id);
    }
  }

  /**
   * Kalkuliere Animation-Progress (0..1; <0 = noch nicht gestartet)
   */
  private calculateAnimationProgress(now: number, anim: ParameterAnimation): number {
    const relative = now - anim.startTime;
    if (relative < 0) return -1;
    if (relative > anim.duration) return 1.1;
    return relative / anim.duration;
  }

  /**
   * Parameter-Animation anwenden:
   * schreibt über die PluginParameterBridge und meldet das Update.
   */
  private applyParameterAnimation(anim: ParameterAnimation, progress: number): void {
    const normalized = anim.envelope(progress);
    const [pluginId, parameterId] = anim.targetId.split(':');

    if (this.config.applyParameters) {
      if (pluginId === 'mixer' && parameterId === 'channel_fade') {
        // Mixer-Fades laufen über die Mixer-Bridge (Kanal-Fader).
        for (const ch of mixerBridge.getActiveChannels()) {
          mixerBridge.setMixerLevel(ch.id, Math.max(0, Math.min(1, normalized)));
        }
      } else {
        pluginParameterBridge.setNormalizedParameter(anim.targetId, normalized);
      }
    }

    if (this.events.onParameterUpdate) {
      this.events.onParameterUpdate(pluginId, parameterId, normalized);
    }
  }

  /**
   * DJ Transition: von Channel A zu Channel B
   * Crossfade (Equal-Power) läuft parallel zum Drop.
   */
  async triggerChannelTransition(
    fromChannelId: string,
    toChannelId: string,
    transitionProfile: DropProfile
  ): Promise<void> {
    const fadeDuration = Math.max(500, transitionProfile.dropDuration);

    await Promise.all([
      this.triggerDrop(transitionProfile, 'immediate'),
      mixerBridge.crossfade(fromChannelId, toChannelId, fadeDuration),
    ]);
  }

  /**
   * Kalkuliere Verzögerung für Quantization (ms) anhand der realen BPM.
   */
  calculateQuantizationDelay(quantization: QuantizationType): number {
    if (quantization === 'instant') return 0;

    const bpm = clockBridge.getClockState().bpm || 120;
    const msPerBeat = 60000 / bpm;

    const beats: Record<Exclude<QuantizationType, 'instant'>, number> = {
      '1/8bar': 0.5,
      '1/4bar': 1,
      '1/2bar': 2,
      '1bar': 4,
      '2bar': 8,
      '4bar': 16,
    };

    return msPerBeat * (beats[quantization as Exclude<QuantizationType, 'instant'>] ?? 16);
  }

  /**
   * Stop aktive Drops
   */
  stopAll(): void {
    this.activeDrops.clear();
    for (const id of this.pendingScheduleIds) clockBridge.cancelScheduledDrop(id);
    this.pendingScheduleIds = [];
    if (this.animationFrameId !== null) {
      cancelFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * Get Status
   */
  getStatus(): {
    activeDrops: number;
    profiles: string[];
    scheduled: number;
  } {
    return {
      activeDrops: this.activeDrops.size,
      profiles: Array.from(this.activeDrops.values()).map((e) => e.profileId),
      scheduled: this.pendingScheduleIds.length,
    };
  }
}

// Export singleton
export const dropEngine = new DropEngine();
