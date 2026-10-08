/**
 * audioMONASTRY · V2RenderFaultGuard (RT-AUDIT-P0-007)
 * =====================================================
 * Fehlerpfad des V2-Live-Sinks im AudioWorklet-Thread.
 *
 * Wirft `process()` eine Exception, deaktiviert Chromium den Prozessor
 * dauerhaft: die ganze DAW ist stumm, ohne Meldung und ohne Wiederanlauf.
 * `v2SinkProcessor.process()` fängt deshalb jeden Fehler und übergibt ihn
 * hierher:
 *   - alle Ausgangskanäle dieses Blocks werden mit 0 gefüllt (Stille nur für
 *     diesen Block, der nächste Block rendert wieder normal),
 *   - der Fehler wird gezählt,
 *   - beim ERSTEN Fehler und danach höchstens einmal pro Sekunde Audio-Zeit
 *     geht `{ type: 'render-error', message, count }` an den Main-Thread.
 * Fehler in der Port-Nachrichtenverarbeitung werden als
 * `{ type: 'message-error', messageType, message }` gemeldet.
 *
 * Der fehlerfreie Render-Pfad berührt diese Klasse nicht (kein Aufruf, keine
 * Allokation). Allokationen (Meldungsobjekt, Fehlertext) entstehen nur im
 * Fehlerfall und sind dort auf höchstens eine Meldung pro Sekunde gedrosselt.
 *
 * Bewusst ohne AudioWorklet-Globals: Audio-Zeit (`frame`) und Port werden
 * übergeben, damit die Logik ohne Worklet-Umgebung testbar ist.
 */

/** Minimaler Port-Vertrag (MessagePort im Worklet, Fake im Test). */
export interface V2FaultPort {
  postMessage(message: unknown): void;
}

export interface V2RenderErrorMessage {
  type: 'render-error';
  message: string;
  count: number;
}

export interface V2MessageErrorMessage {
  type: 'message-error';
  messageType: string;
  message: string;
}

/** Maximale Länge eines gemeldeten Fehlertexts (Port-Nachricht klein halten). */
const MAX_MESSAGE_LENGTH = 160;

/** Fehlertext ohne Stack; wirft selbst nie. */
export function describeFault(error: unknown): string {
  try {
    const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return raw.slice(0, MAX_MESSAGE_LENGTH);
  } catch {
    return 'unbekannter Fehler';
  }
}

/** Füllt alle Kanäle aller Ausgänge mit 0 (Stille für den fehlerhaften Block). */
export function silenceOutputs(outputs: Float32Array[][] | null | undefined): void {
  if (!outputs) return;
  for (let o = 0; o < outputs.length; o++) {
    const output = outputs[o];
    if (!output) continue;
    for (let ch = 0; ch < output.length; ch++) {
      const channel = output[ch];
      if (channel) channel.fill(0);
    }
  }
}

export class V2RenderFaultGuard {
  /** Anzahl der Render-Fehler seit Start dieses Prozessors. */
  errorCount = 0;
  /** Anzahl der Fehler in der Nachrichtenverarbeitung. */
  messageErrorCount = 0;
  /** Anzahl tatsächlich gesendeter `render-error`-Meldungen. */
  reportCount = 0;
  /** Mindestabstand zwischen zwei `render-error`-Meldungen in Frames. */
  readonly reportIntervalFrames: number;
  private lastReportFrame = 0;

  constructor(sampleRate: number, reportIntervalSeconds = 1) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    this.reportIntervalFrames = Math.max(1, Math.round(sr * reportIntervalSeconds));
  }

  /**
   * Fehler im Render-Pfad: Ausgang stumm, zählen, gedrosselt melden.
   * `frame` ist die Audio-Zeit des Blocks (`currentFrame` im Worklet).
   * Wirft selbst nie.
   */
  onRenderError(error: unknown, outputs: Float32Array[][], frame: number, port: V2FaultPort | null | undefined): void {
    try {
      silenceOutputs(outputs);
    } catch { /* Ausgang nicht beschreibbar – nichts weiter zu tun */ }
    this.errorCount++;
    const due = this.errorCount === 1
      || frame - this.lastReportFrame >= this.reportIntervalFrames
      // Zeitsprung rückwärts (Kontext-Neustart): wieder melden dürfen.
      || frame < this.lastReportFrame;
    if (!due) return;
    this.lastReportFrame = frame;
    this.reportCount++;
    const message: V2RenderErrorMessage = { type: 'render-error', message: describeFault(error), count: this.errorCount };
    safePost(port, message);
  }

  /** Fehler beim Verarbeiten einer Port-Nachricht melden. Wirft selbst nie. */
  onMessageError(error: unknown, messageType: unknown, port: V2FaultPort | null | undefined): void {
    this.messageErrorCount++;
    const message: V2MessageErrorMessage = {
      type: 'message-error',
      messageType: typeof messageType === 'string' ? messageType : 'unknown',
      message: describeFault(error),
    };
    safePost(port, message);
  }
}

function safePost(port: V2FaultPort | null | undefined, message: unknown): void {
  try {
    port?.postMessage(message);
  } catch { /* Port geschlossen – Meldung entfällt, Audio-Thread läuft weiter */ }
}
