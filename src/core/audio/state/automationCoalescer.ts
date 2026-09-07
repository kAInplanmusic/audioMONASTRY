/**
 * audioMONASTRY · Automation-Coalescer
 * ====================================
 * Sammelt hochfrequente Parameter-Updates pro Key und flushed sie gebündelt
 * im nächsten Frame/Interval. Verhindert, dass bei 1000 Events/s jeder Event
 * einzeln als Worklet-Port-Message rausgeht.
 *
 * Pro Key bleibt der letzte Wert erhalten (Backpressure-freundlich: Zwischenwerte
 * werden verworfen, der Endwert wird immer gesendet).
 */

export class AutomationCoalescer {
  private pending = new Map<string, unknown>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flush: (key: string, payload: unknown) => void,
    private readonly intervalMs = 16,
  ) {}

  /** Aktuellen Wert für `key` vormerken; Flush wird frühestens nach intervalMs ausgelöst. */
  push(key: string, payload: unknown): void {
    this.pending.set(key, payload);
    if (this.timer == null) {
      this.timer = setTimeout(() => this.flushNow(), this.intervalMs);
    }
  }

  /** Alle gesammelten Updates sofort senden (z. B. vor Worklet-Teardown). */
  flushNow(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [key, payload] of entries) {
      this.flush(key, payload);
    }
  }

  dispose(): void {
    this.flushNow();
  }
}
