/**
 * audioMONASTRY · LLM-Antworten als typisierte Objekte (DA-2026-10-17-017)
 * =======================================================================
 * Ein Modell antwortet nicht immer mit dem erwarteten Objekt. Vorher wurde die
 * Antwort mit `JSON.parse(...) as Record<string, unknown>` behandelt und
 * anschliessend gespreadet/gelesen. Zwei Faelle gingen dabei schief:
 *
 *   `[{"chosen":"a"}]`  -> Array; `{...parsedJson}` erzeugt die Keys "0", "1"
 *   `["a","b"]`         -> Array aus Strings; Feldzugriffe laufen ins Leere
 *
 * Diese Datei normalisiert fail-safe:
 *   - Objekt                        -> Objekt
 *   - Array mit GENAU EINEM Objekt  -> dieses Objekt
 *   - alles andere (Array aus Skalaren, Zahl, String, null) -> null
 *
 * Damit gibt es keinen Pfad mehr, auf dem ein "Aggregator-Ergebnis" als Liste
 * weiterverarbeitet wird.
 */
import { z } from 'zod';

export type JsonObject = Record<string, unknown>;

const JsonObjectSchema = z.record(z.string(), z.unknown());

/** Type-Guard: echtes, nicht-array Objekt. */
export function isJsonObject(value: unknown): value is JsonObject {
  return JsonObjectSchema.safeParse(value).success;
}

/**
 * Normalisiert einen bereits geparsten JSON-Wert auf ein Objekt.
 * Ein Einelement-Array mit Objekt wird ausgepackt (Modelle verpacken Antworten
 * gelegentlich in `[ … ]`); alles andere ist `null`.
 */
export function normalizeJsonObject(value: unknown): JsonObject | null {
  if (isJsonObject(value)) return value;
  if (Array.isArray(value) && value.length === 1) {
    const [only] = value;
    if (isJsonObject(only)) return only;
  }
  return null;
}

/** Entfernt Markdown-Zaeune (```json … ```) und Whitespace. */
export function stripJsonFence(raw: string): string {
  let text = String(raw ?? '').trim();
  if (text.startsWith('```json')) text = text.slice(7);
  else if (text.startsWith('```')) text = text.slice(3);
  if (text.endsWith('```')) text = text.slice(0, -3);
  return text.trim();
}

/**
 * Parst eine Modellantwort und liefert NUR dann ein Objekt, wenn die Antwort
 * wirklich eines ist. `null` heisst: unbrauchbar (Aufrufer nutzt seinen
 * Fallback) – es wird nie ein Array als Objekt weitergereicht.
 */
export function parseLlmJsonObject(raw: unknown): JsonObject | null {
  if (typeof raw !== 'string') return normalizeJsonObject(raw);
  const text = stripJsonFence(raw);
  if (!text) return null;
  try {
    return normalizeJsonObject(JSON.parse(text));
  } catch {
    return null;
  }
}
