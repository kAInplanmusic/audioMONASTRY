/**
 * audioMONASTRY · V2StepQueue (RT-AUDIT-P0-003)
 * ==============================================
 * Vorallokierte, nach absolutem Sample-Frame sortierte Warteschlange für
 * geplante Sequencer-Steps im V2-Live-Pfad.
 *
 * Problem vorher: `V2SampleClock` legt ungerade Steps mit Swing HINTER das
 * aktuelle Render-Quantum (frame ≥ currentFrame + length). Der Processor
 * verwarf solche Steps (`startSample >= length → continue`) – mit Swing > 0
 * fiel damit rund die Hälfte aller Steps aus.
 *
 * Jetzt: Jeder Step wird mit seinem absoluten Frame vorgemerkt und genau in dem
 * Block gefeuert, in den sein Frame fällt (`frame < blockStart + length`).
 * Verspätete Einträge (frame < blockStart, z. B. durch PDC-Klemmung) feuern am
 * Blockanfang (Startsample 0) statt verloren zu gehen.
 *
 * Echtzeit-Regeln: feste Kapazität (Ringpuffer in typisierten Arrays), keine
 * Allokation in `push`/`popDue`, keine WebAudio-Globals – dadurch in Node-Tests
 * und im AudioWorklet identisch nutzbar.
 */

export const V2_STEP_QUEUE_CAPACITY = 64;

export class V2StepQueue {
  readonly capacity: number;
  private readonly frames: Float64Array;
  private readonly steps: Int32Array;
  private readonly secondsPerStep: Float64Array;
  /** Index des ältesten (= frühesten) Eintrags im Ring. */
  private head = 0;
  private count = 0;
  /** Anzahl der wegen voller Queue abgewiesenen Steps (Diagnose, sollte 0 bleiben). */
  overflowCount = 0;

  constructor(capacity = V2_STEP_QUEUE_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.frames = new Float64Array(this.capacity);
    this.steps = new Int32Array(this.capacity);
    this.secondsPerStep = new Float64Array(this.capacity);
  }

  /** Anzahl der vorgemerkten Steps. */
  get size(): number {
    return this.count;
  }

  /** Verwirft alle vorgemerkten Steps (Transport-Stopp/-Neustart, Zeitsprung). */
  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /**
   * Merkt einen Step am absoluten Frame vor. Die Queue bleibt nach Frame
   * sortiert (Einfügen vom Ende her; im Normalfall kommen Steps bereits in
   * Reihenfolge an, das Einfügen ist dann O(1)). Liefert `false`, wenn die
   * Queue voll ist (der Step wird dann gezählt und verworfen).
   */
  push(frame: number, step: number, secondsPerStep = 0): boolean {
    if (this.count >= this.capacity) {
      this.overflowCount++;
      return false;
    }
    const cap = this.capacity;
    // Von hinten nach vorn: alle Einträge mit größerem Frame eine Position
    // nach hinten schieben (stabil: gleiche Frames behalten ihre Reihenfolge).
    let pos = this.count;
    while (pos > 0) {
      const prev = (this.head + pos - 1) % cap;
      if (this.frames[prev] <= frame) break;
      const cur = (this.head + pos) % cap;
      this.frames[cur] = this.frames[prev];
      this.steps[cur] = this.steps[prev];
      this.secondsPerStep[cur] = this.secondsPerStep[prev];
      pos--;
    }
    const idx = (this.head + pos) % cap;
    this.frames[idx] = frame;
    this.steps[idx] = step;
    this.secondsPerStep[idx] = secondsPerStep;
    this.count++;
    return true;
  }

  /**
   * Entnimmt alle Einträge mit `frame < blockStart + length` (in Frame-
   * Reihenfolge) und schreibt sie in die vorallokierten Ausgabe-Arrays:
   *   - `outStart[k]`  Startsample im Block = max(0, frame − blockStart)
   *   - `outStep[k]`   Step-Index
   *   - `outFrame[k]`  absoluter Frame (für die Audio-Zeit der UI-Meldung)
   *   - `outSps[k]`    Sekunden pro Step zum Planungszeitpunkt
   * Spätere Einträge bleiben in der Queue. Liefert die Anzahl der gefeuerten
   * Einträge (höchstens `outStart.length`; der Rest feuert im nächsten Block).
   */
  popDue(
    blockStart: number,
    length: number,
    outStart: Int32Array,
    outStep: Int32Array,
    outFrame: Float64Array,
    outSps: Float64Array,
  ): number {
    const end = blockStart + length;
    const max = Math.min(outStart.length, outStep.length, outFrame.length, outSps.length);
    let n = 0;
    while (this.count > 0 && n < max) {
      const idx = this.head;
      const frame = this.frames[idx];
      if (frame >= end) break;
      const start = frame - blockStart;
      outStart[n] = start > 0 ? start : 0;
      outStep[n] = this.steps[idx];
      outFrame[n] = frame;
      outSps[n] = this.secondsPerStep[idx];
      n++;
      this.head = (this.head + 1) % this.capacity;
      this.count--;
    }
    if (this.count === 0) this.head = 0;
    return n;
  }
}
