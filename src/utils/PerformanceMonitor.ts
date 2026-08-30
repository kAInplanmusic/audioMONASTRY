/**
 * audioMONASTRY · PerformanceMonitor (Task 2.2.1 / finale Liste F2)
 * ==================================================================
 * Leichtgewichtiger Echtzeit-Monitor für Reaktionszeit & Stabilität:
 *  - FPS / Frame-Jitter (Main-Thread-Render-Loop)
 *  - Dropped-Frame-Zähler
 *  - Audio-Health (Context-State, Sample-Rate, Basis-Latenz)
 *
 * Der Monitor läuft ausschließlich auf dem Main-Thread und blockiert niemals
 * den Audio-Thread. Die Werte werden von Terminals (z. B. DSPTerminal) per
 * `snapshot()` abgerufen und angezeigt.
 */
export interface PerformanceSnapshot {
  fps: number;
  jitterMs: number;
  droppedFrames: number;
  frameTimeMs: number;
  audioState: string;
  audioSampleRate: number;
  audioBaseLatencyMs: number;
}

class PerformanceMonitor {
  private running = false;
  private rafId = 0;
  private lastFrameTime = 0;
  private lastIntervalTime = 0;
  private frameCount = 0;
  private intervalFrameCount = 0;
  private jitterSum = 0;
  private lastDelta = 16.7;
  private droppedFrames = 0;
  private fps = 0;
  private jitterMs = 0;

  private audioStateProvider: () => { state: string; sampleRate: number; baseLatencyMs: number } =
    () => ({ state: 'closed', sampleRate: 0, baseLatencyMs: 0 });

  /** Audio-Health-Quelle registrieren (z. B. audioEngine.getAudioHealth). */
  setAudioStateProvider(fn: () => { state: string; sampleRate: number; baseLatencyMs: number }): void {
    this.audioStateProvider = fn;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    this.lastIntervalTime = this.lastFrameTime;
    const loop = (now: number) => {
      if (!this.running) return;
      const delta = now - this.lastFrameTime;
      this.lastFrameTime = now;
      this.frameCount++;
      this.intervalFrameCount++;

      // Jitter = Abweichung der Frame-Dauer vom gleitenden Mittel.
      if (delta > 0 && delta < 500) {
        this.lastDelta = this.lastDelta * 0.9 + delta * 0.1;
        this.jitterSum += Math.abs(delta - this.lastDelta);
      }
      // Dropped Frames: deutliche Überschreitung des 60-Hz-Intervalls.
      if (delta > 34) this.droppedFrames++;

      // 1-Sekunden-Intervall auswerten.
      if (now - this.lastIntervalTime >= 1000) {
        const intervalSec = (now - this.lastIntervalTime) / 1000;
        this.fps = this.intervalFrameCount / intervalSec;
        this.jitterMs = this.intervalFrameCount > 0 ? this.jitterSum / this.intervalFrameCount : 0;
        this.jitterSum = 0;
        this.intervalFrameCount = 0;
        this.lastIntervalTime = now;
      }

      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  snapshot(): PerformanceSnapshot {
    const audio = this.audioStateProvider();
    return {
      fps: Math.round(this.fps * 10) / 10,
      jitterMs: Math.round(this.jitterMs * 100) / 100,
      droppedFrames: this.droppedFrames,
      frameTimeMs: Math.round(this.lastDelta * 100) / 100,
      audioState: audio.state,
      audioSampleRate: audio.sampleRate,
      audioBaseLatencyMs: Math.round(audio.baseLatencyMs * 100) / 100,
    };
  }
}

export const performanceMonitor = new PerformanceMonitor();
