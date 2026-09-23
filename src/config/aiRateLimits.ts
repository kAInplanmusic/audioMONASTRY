/**
 * audioMONASTRY · AI-Rate-Limits (AITodo Phase 18)
 * =================================================
 * Explizite, zentral konfigurierbare AI_RATE_*-Limits für den Server.
 * Ohne gesetzte Env-Variablen gelten konservative Defaults (Kostenbremse).
 * Pure Resolver-Funktion → serverlos testbar.
 *
 * ---------------------------------------------------------------------------
 * BEREINIGT AM 2026-09-23 (QUAL-P2-007) — drei Felder entfernt.
 *
 * Befund: das Interface deklarierte FÜNF Felder und las alle fünf aus der
 * Umgebung, aber nur ZWEI hatten einen Abnehmer (`expensiveWindowMs` und
 * `expensiveMax`, benutzt in `server.ts:598-607`). Nachgewiesen mit
 * `rg -n "concurrencyMax" --glob '!node_modules' --glob '!dist' .` — Treffer nur
 * im Interface, im Default, im Resolver und in einem Unit-Test. Für `max` und
 * `windowMs` fand sich nicht einmal ein Test.
 *
 * Das ist die unangenehmste Sorte Befund: in den Tests sieht die Kostenbremse
 * vollständig aus, im Betrieb sind drei ihrer fünf Felder wirkungslos. Wer
 * `AI_RATE_MAX` oder `AI_RATE_CONCURRENCY_MAX` setzte, bekam keine Wirkung —
 * aber das Gefühl, etwas begrenzt zu haben.
 *
 * WARUM ENTFERNT UND NICHT DURCHGESETZT:
 *   * `concurrencyMax` (gemeint: höchstens N gleichzeitige KI-Aufträge) ist mit
 *     einem Zähler im HTTP-Pfad NICHT korrekt umzusetzen. Ein RunPod-Auftrag
 *     läuft weiter, wenn die HTTP-Antwort längst zurück ist — die Route startet
 *     den Auftrag und antwortet sofort. Ein „in-flight"-Zähler würde damit
 *     gleichzeitige *Anfragen* begrenzen und nicht gleichzeitige *Aufträge*:
 *     eine Zahl, die etwas anderes misst als ihr Name sagt. Sauber ginge es nur
 *     über eine Auftrags-Lebenszyklus-Verfolgung (Start → Abschluss) — das ist
 *     ein eigenes Vorhaben, kein Nebenbei-Fix.
 *   * `max`/`windowMs` (allgemeines AI-Limit) wären redundant: die teuren Pfade
 *     sind bereits über `expensiveMax` begrenzt, und alle `/api`-Pfade laufen
 *     ohnehin durch den allgemeinen Limiter (60/min, `server.ts:570-575`).
 *
 * Die Substanz des Befunds ist damit NICHT verschwunden, sondern verlagert: dass
 * die Parallelität der KI-Aufträge unbegrenzt ist (für keinen der acht
 * RunPod-Endpunkte ist ein `workersMax` gesetzt), steht als offener Punkt in
 * `MASTERTODOENDE.json` (SEC-P2-004) und in `docs/SEC_BLOCK2_ATTACKS.md`,
 * Angriff 1 — mit Beleg. Eine Env-Variable, die nichts tut, ist dort die
 * schlechtere Ablage: sie erzeugt den Anschein eines Schutzes.
 * ---------------------------------------------------------------------------
 */

export interface AiRateLimitConfig {
  /** Fenster für die teuren Pfade, in Millisekunden. */
  expensiveWindowMs: number;
  /** Erlaubte Anfragen auf den teuren Pfaden je Fenster. */
  expensiveMax: number;
}

export const AI_RATE_DEFAULTS: AiRateLimitConfig = {
  expensiveWindowMs: 60 * 1000,
  expensiveMax: 10,
};

/** Liest AI_RATE_*-Env-Werte (Server) bzw. liefert Defaults (Browser/Tests). */
export function resolveAiRateLimits(env: Record<string, string | undefined> = {}): AiRateLimitConfig {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    expensiveWindowMs: num('AI_RATE_EXPENSIVE_WINDOW_MS', AI_RATE_DEFAULTS.expensiveWindowMs),
    expensiveMax: num('AI_RATE_EXPENSIVE_MAX', AI_RATE_DEFAULTS.expensiveMax),
  };
}
