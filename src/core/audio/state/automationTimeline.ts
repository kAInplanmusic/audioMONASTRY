/**
 * audioMONASTRY · Automations-Spuren auf einer Timeline (ZUK-005)
 * ==============================================================
 * Reines, deterministisches Datenmodell für Automations-Lanes. Eine Lane
 * gehört zu genau einem Node-Parameter-Paar `(nodeId, parameterId)` und hält
 * ihre Punkte nach Zeit sortiert; Werte werden auf den Parameterbereich
 * `[min, max]` geklemmt.
 *
 * Bewusst KEIN zweiter Automations-Store: die Lanes liefern nur Werte, das
 * Anwenden auf die Nodes bleibt beim `V2NodeAutomationCoalescer`
 * (siehe `./v2NodeAutomation.ts`, das diese Timeline optional liest).
 * Kein Audio-Context-, DOM- oder Tone-Zugriff – damit offline testbar.
 *
 * Kurven-Semantik: `curve` eines Punktes beschreibt das Segment AB diesem
 * Punkt bis zum nächsten Punkt.
 *  - `linear`      : geradlinig zwischen beiden Werten
 *  - `exponential` : geometrisch (`a * (b/a)^t`), wie ein exponentieller
 *                    Audio-Ramp; bei 0 oder Vorzeichenwechsel linear
 *                    (ein geometrischer Ramp ist dort nicht definiert)
 *  - `hold`        : hält den Wert des linken Punktes bis zum rechten Punkt
 *
 * Zeit-Semantik: vor dem ersten Punkt gilt dessen Wert, nach dem letzten
 * Punkt dessen Wert (auch jenseits der Lane-Länge). Zu einer exakten
 * Punktzeit gilt immer der Wert dieses Punktes – auch bei `hold`.
 */
/** Form des Segments, das an diesem Punkt beginnt. */
export type AutomationCurve = 'linear' | 'exponential' | 'hold';

/** Ein gespeicherter Automations-Punkt. */
export interface AutomationLanePoint {
  /** Zeitpunkt auf der Timeline in Sekunden (>= 0). */
  timeSec: number;
  /** Auf den Parameterbereich geklemmter Wert. */
  value: number;
  /** Form des Segments AB diesem Punkt bis zum nächsten Punkt. */
  curve: AutomationCurve;
}

/** Eingabeform eines Punktes: `curve` ist optional und defaultet auf `linear`. */
export interface AutomationPointInput {
  timeSec: number;
  value: number;
  curve?: AutomationCurve;
}

/** Wertebereich des automatisierten Parameters (Klemmung). */
export interface AutomationLaneRange {
  min: number;
  max: number;
  /** Startwert, wenn die Lane noch keinen Punkt hat. Default: `min`-nahe 0 bzw. `min`. */
  defaultValue?: number;
}

/** Unveränderliche Sicht auf eine Lane (Kopie, kein Live-Objekt). */
export interface AutomationLane {
  readonly id: string;
  readonly nodeId: string;
  readonly parameterId: string;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
  /** Nie kürzer als der letzte Punkt (siehe `setLength`). */
  readonly lengthSec: number;
  readonly points: readonly AutomationLanePoint[];
}

interface LaneState {
  readonly id: string;
  readonly nodeId: string;
  readonly parameterId: string;
  min: number;
  max: number;
  defaultValue: number;
  /** Explizit gesetzte Länge; `null` = aus dem letzten Punkt abgeleitet. */
  explicitLengthSec: number | null;
  /** Immer nach `timeSec` sortiert, ohne doppelte Zeiten. */
  points: AutomationLanePoint[];
}

function assertFiniteTime(timeSec: number, label: string): void {
  if (!Number.isFinite(timeSec) || timeSec < 0) {
    throw new RangeError(`${label}: Zeit muss eine endliche Sekundenzahl >= 0 sein (war: ${String(timeSec)})`);
  }
}

function assertFiniteValue(value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Automations-Wert muss endlich sein (war: ${String(value)})`);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function assertCurve(curve: string): asserts curve is AutomationCurve {
  if (curve !== 'linear' && curve !== 'exponential' && curve !== 'hold') {
    throw new RangeError(`Unbekannte Automations-Kurve: ${curve}`);
  }
}

function normalizePoint(input: AutomationPointInput, min: number, max: number): AutomationLanePoint {
  assertFiniteTime(input.timeSec, 'addPoint');
  assertFiniteValue(input.value);
  const curve = input.curve ?? 'linear';
  assertCurve(curve);
  return { timeSec: input.timeSec, value: clamp(input.value, min, max), curve };
}

/**
 * Sortiert Punkte nach Zeit und dedupliziert: bei gleicher Zeit gewinnt der
 * SPÄTERE Punkt (Reihenfolge der Eingabe) – dieselbe Regel, die ein
 * nachträgliches Verschieben auf eine belegte Zeit hat.
 *
 * Exportiert, weil Import-/Deserialisierungspfade (UI, Projektdatei) rohe,
 * unsortierte Punktlisten liefern dürfen.
 */
export function sortAutomationPoints(
  points: readonly AutomationPointInput[],
  range: { min?: number; max?: number } = {},
): AutomationLanePoint[] {
  const min = range.min ?? Number.NEGATIVE_INFINITY;
  const max = range.max ?? Number.POSITIVE_INFINITY;
  const ordered = points.map((point, index) => ({ point: normalizePoint(point, min, max), index }));
  // Stabil über den Eingabeindex: gleiche Zeiten behalten ihre Reihenfolge,
  // damit "der spätere Punkt gewinnt" deterministisch bleibt.
  ordered.sort((a, b) => a.point.timeSec - b.point.timeSec || a.index - b.index);
  const out: AutomationLanePoint[] = [];
  for (const entry of ordered) {
    if (out.length > 0 && out[out.length - 1].timeSec === entry.point.timeSec) {
      out[out.length - 1] = entry.point; // später gewinnt
    } else {
      out.push(entry.point);
    }
  }
  return out;
}

/**
 * Wert einer sortierten, deduplizierten Punktliste zum Zeitpunkt `timeSec`.
 * Binärsuche (O(log n)) statt linearer Suche, weil die Funktion pro
 * Transport-Tick und Lane aufgerufen wird.
 */
export function evaluateAutomationPoints(
  points: readonly AutomationLanePoint[],
  timeSec: number,
): number {
  const n = points.length;
  if (n === 0) return Number.NaN;
  const first = points[0];
  if (timeSec <= first.timeSec) return first.value;
  const last = points[n - 1];
  if (timeSec >= last.timeSec) return last.value;

  // letzter Punkt mit timeSec <= gesucht
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].timeSec <= timeSec) lo = mid;
    else hi = mid - 1;
  }
  const left = points[lo];
  if (left.timeSec === timeSec) return left.value; // exakte Punktzeit
  const right = points[lo + 1];
  const span = right.timeSec - left.timeSec;
  if (span <= 0) return right.value; // kann bei deduplizierter Liste nicht auftreten
  const t = (timeSec - left.timeSec) / span;
  switch (left.curve) {
    case 'hold':
      return left.value;
    case 'exponential': {
      if (left.value === 0 || right.value === 0 || Math.sign(left.value) !== Math.sign(right.value)) {
        // Kein definierter geometrischer Ramp (Null oder Vorzeichenwechsel):
        // linear überbrücken statt NaN zu liefern.
        return left.value + (right.value - left.value) * t;
      }
      return left.value * Math.pow(right.value / left.value, t);
    }
    case 'linear':
    default:
      return left.value + (right.value - left.value) * t;
  }
}

function laneLength(lane: LaneState): number {
  const lastPointSec = lane.points.length > 0 ? lane.points[lane.points.length - 1].timeSec : 0;
  return Math.max(lane.explicitLengthSec ?? 0, lastPointSec);
}

function snapshot(lane: LaneState): AutomationLane {
  return {
    id: lane.id,
    nodeId: lane.nodeId,
    parameterId: lane.parameterId,
    min: lane.min,
    max: lane.max,
    defaultValue: lane.defaultValue,
    lengthSec: laneLength(lane),
    points: lane.points.map((point) => ({ ...point })),
  };
}

/**
 * Sammlung von Automations-Lanes, gekeyed über `(nodeId, parameterId)`.
 *
 * Lane-IDs sind `${nodeId}::${parameterId}` – dieselbe Konvention wie der
 * Key des `AutomationCoalescer`. Beide Teile dürfen deshalb kein `::`
 * enthalten (Node-IDs mit einfachem `:` wie `eq:auto` sind unproblematisch,
 * weil `::` als Ganzes gesucht wird).
 */
export class AutomationTimeline {
  private readonly lanes = new Map<string, LaneState>();

  /** Lane-ID für ein Node-Parameter-Paar. */
  static laneId(nodeId: string, parameterId: string): string {
    if (!nodeId || !parameterId) {
      throw new RangeError('Automations-Lane braucht nodeId und parameterId');
    }
    return `${nodeId}::${parameterId}`;
  }

  /**
   * Legt eine Lane an oder liefert die bestehende (idempotent, damit ein
   * zweiter UI-Aufruf die Punkte nicht wegwirft). Der Bereich wird nur beim
   * ersten Anlegen gesetzt – für Änderungen `setRange` verwenden.
   */
  createLane(nodeId: string, parameterId: string, range: AutomationLaneRange = { min: 0, max: 1 }): string {
    const id = AutomationTimeline.laneId(nodeId, parameterId);
    const existing = this.lanes.get(id);
    if (existing) return existing.id;
    const min = Number.isFinite(range.min) ? range.min : 0;
    const max = Number.isFinite(range.max) ? range.max : 1;
    const defaultValue = clamp(range.defaultValue ?? min, min, max);
    this.lanes.set(id, {
      id,
      nodeId,
      parameterId,
      min,
      max,
      defaultValue,
      explicitLengthSec: null,
      points: [],
    });
    return id;
  }

  hasLane(laneId: string): boolean {
    return this.lanes.has(laneId);
  }

  hasLaneFor(nodeId: string, parameterId: string): boolean {
    return this.lanes.has(AutomationTimeline.laneId(nodeId, parameterId));
  }

  getLane(laneId: string): AutomationLane | undefined {
    const lane = this.lanes.get(laneId);
    return lane ? snapshot(lane) : undefined;
  }

  getLaneFor(nodeId: string, parameterId: string): AutomationLane | undefined {
    return this.getLane(AutomationTimeline.laneId(nodeId, parameterId));
  }

  listLanes(): AutomationLane[] {
    return [...this.lanes.values()].map(snapshot);
  }

  /**
   * Schlanke Iteration über alle Lanes (Transport-Tick): liefert nur
   * `(nodeId, parameterId)`, ohne Snapshot-/Punkt-Kopien pro Aufruf.
   */
  forEachLane(visit: (nodeId: string, parameterId: string) => void): void {
    for (const lane of this.lanes.values()) visit(lane.nodeId, lane.parameterId);
  }

  /** Entfernt eine Lane samt Punkten. `true`, wenn sie existierte. */
  removeLane(laneId: string): boolean {
    return this.lanes.delete(laneId);
  }

  /** Ändert den Wertebereich und klemmt bestehende Punkte nach. */
  setRange(laneId: string, min: number, max: number, defaultValue?: number): void {
    const lane = this.requireLane(laneId, 'setRange');
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new RangeError(`setRange: ungültiger Bereich [${String(min)}, ${String(max)}]`);
    }
    lane.min = min;
    lane.max = max;
    lane.defaultValue = clamp(defaultValue ?? lane.defaultValue, min, max);
    lane.points = lane.points.map((point) => ({ ...point, value: clamp(point.value, min, max) }));
  }

  /**
   * Setzt die Lane-Länge (Timeline-Breite der Spur). Kürzer als der letzte
   * Punkt geht nicht – die Länge bleibt dann auf der letzten Punktzeit, damit
   * kein Punkt hinter dem Spurende liegt.
   */
  setLength(laneId: string, lengthSec: number): void {
    const lane = this.requireLane(laneId, 'setLength');
    assertFiniteTime(lengthSec, 'setLength');
    lane.explicitLengthSec = lengthSec;
  }

  /**
   * Fügt einen Punkt hinzu. Eine bereits belegte Zeit wird überschrieben
   * ("der spätere Punkt gewinnt"). Rückgabe: der gespeicherte (geklemmte)
   * Punkt.
   */
  addPoint(laneId: string, point: AutomationPointInput): AutomationLanePoint {
    const lane = this.requireLane(laneId, 'addPoint');
    const normalized = normalizePoint(point, lane.min, lane.max);
    lane.points = sortAutomationPoints([...lane.points, normalized], lane);
    const stored = lane.points.find((entry) => entry.timeSec === normalized.timeSec);
    return stored ?? normalized;
  }

  /** Fügt mehrere Punkte ein; unsortierte Eingabe und Doppelzeiten sind erlaubt. */
  addPoints(laneId: string, points: readonly AutomationPointInput[]): AutomationLanePoint[] {
    const lane = this.requireLane(laneId, 'addPoints');
    if (points.length === 0) return lane.points.map((point) => ({ ...point }));
    const normalized = points.map((point) => normalizePoint(point, lane.min, lane.max));
    lane.points = sortAutomationPoints([...lane.points, ...normalized], lane);
    return lane.points.map((point) => ({ ...point }));
  }

  /**
   * Verschiebt den Punkt bei `fromTimeSec` auf `toTimeSec` (optional mit
   * neuem Wert/neuer Kurve). Eine belegte Zielzeit wird überschrieben –
   * derselbe "der spätere Punkt gewinnt"-Fall wie beim Einfügen.
   * Rückgabe: der verschobene Punkt oder `null`, wenn es keinen Punkt bei
   * `fromTimeSec` gibt.
   */
  movePoint(
    laneId: string,
    fromTimeSec: number,
    toTimeSec: number,
    patch: { value?: number; curve?: AutomationCurve } = {},
  ): AutomationLanePoint | null {
    const lane = this.requireLane(laneId, 'movePoint');
    assertFiniteTime(fromTimeSec, 'movePoint');
    assertFiniteTime(toTimeSec, 'movePoint');
    const index = lane.points.findIndex((point) => point.timeSec === fromTimeSec);
    if (index < 0) return null;
    const current = lane.points[index];
    const next: AutomationLanePoint = {
      timeSec: toTimeSec,
      value: patch.value === undefined
        ? current.value
        : clamp(this.requireFiniteValue(patch.value), lane.min, lane.max),
      curve: patch.curve ?? current.curve,
    };
    assertCurve(next.curve);
    lane.points = sortAutomationPoints(
      [...lane.points.filter((_, i) => i !== index), next],
      lane,
    );
    const stored = lane.points.find((point) => point.timeSec === toTimeSec);
    return stored ?? next;
  }

  /** Entfernt den Punkt bei `timeSec`. `true`, wenn es ihn gab. */
  removePoint(laneId: string, timeSec: number): boolean {
    const lane = this.requireLane(laneId, 'removePoint');
    assertFiniteTime(timeSec, 'removePoint');
    const index = lane.points.findIndex((point) => point.timeSec === timeSec);
    if (index < 0) return false;
    lane.points.splice(index, 1);
    return true;
  }

  clearPoints(laneId: string): void {
    this.requireLane(laneId, 'clearPoints').points = [];
  }

  /**
   * Defensives Sortieren (idempotent): für importierten Zustand, der die
   * Invariante "sortiert + eindeutige Zeiten" nicht garantiert.
   */
  sortLane(laneId: string): void {
    const lane = this.requireLane(laneId, 'sortLane');
    lane.points = sortAutomationPoints(lane.points, lane);
  }

  /**
   * Wert der Lane zum Zeitpunkt `timeSec` (Sekunden), geklemmt auf den
   * Parameterbereich. Wirft bei unbekannter Lane – für den Audio-/Transport-
   * Pfad gibt es `evaluateAt`, das `null` liefert.
   */
  evaluate(laneId: string, timeSec: number): number {
    const lane = this.requireLane(laneId, 'evaluate');
    assertFiniteTime(timeSec, 'evaluate');
    return this.evaluateLane(lane, timeSec);
  }

  /** Wie `evaluate`, aber ohne Exception: `null`, wenn keine Lane existiert. */
  evaluateAt(nodeId: string, parameterId: string, timeSec: number): number | null {
    const lane = this.lanes.get(AutomationTimeline.laneId(nodeId, parameterId));
    if (!lane) return null;
    assertFiniteTime(timeSec, 'evaluateAt');
    return this.evaluateLane(lane, timeSec);
  }

  private evaluateLane(lane: LaneState, timeSec: number): number {
    if (lane.points.length === 0) return clamp(lane.defaultValue, lane.min, lane.max);
    const raw = evaluateAutomationPoints(lane.points, timeSec);
    return clamp(raw, lane.min, lane.max);
  }

  private requireLane(laneId: string, label: string): LaneState {
    const lane = this.lanes.get(laneId);
    if (!lane) throw new RangeError(`${label}: Automations-Lane unbekannt: ${laneId}`);
    return lane;
  }

  private requireFiniteValue(value: number): number {
    assertFiniteValue(value);
    return value;
  }
}
