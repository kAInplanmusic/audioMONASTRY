/**
 * audioMONASTRY · Persistenz – versionierter Snapshot-Umschlag + Migrationen
 * =========================================================================
 * PERSIST-P1-002: Jeder gespeicherte Zustand bekommt einen Umschlag mit
 * `schemaVersion`, monotoner `revision` und einem `idempotencyKey`. Der Schlüssel
 * bleibt bei einem Retry DESSELBEN Stands gleich → wiederholtes Senden ist
 * idempotent. Alte Stände werden über eine Migrationskette auf die aktuelle
 * Version gehoben, statt sie zu verwerfen.
 *
 * Bewusst rein (kein IndexedDB/Netz, keine Zeit-/Zufallsquelle im Inneren),
 * damit die Abbildung testbar und deterministisch ist.
 */

/** Aktuelle Schema-Version. Bei Breaking Changes erhöhen + Migration ergänzen. */
export const SNAPSHOT_SCHEMA_VERSION = 2;

export interface SnapshotEnvelope<T = unknown> {
  schemaVersion: number;
  /** Monoton steigende Revision (pro Store). */
  revision: number;
  /** Stabil über Retries desselben Stands (Idempotenz). */
  idempotencyKey: string;
  savedAt: number;
  payload: T;
}

type RawRecord = Record<string, unknown>;

/** Migriert eine Version auf die NÄCHSTE (Rückgabe null = nicht migrierbar). */
export type SnapshotMigration = (raw: RawRecord) => RawRecord | null;

/**
 * Migrationskette: `version → Migration auf version + 1`.
 * v1: roher Zustand ohne Umschlag (Revision/Key/Zeitstempel fehlten).
 */
export const SNAPSHOT_MIGRATIONS: Record<number, SnapshotMigration> = {
  1: (raw) => {
    const revision = typeof raw.revision === 'number' && Number.isFinite(raw.revision) ? raw.revision : 0;
    return {
      schemaVersion: 2,
      revision,
      idempotencyKey: typeof raw.idempotencyKey === 'string' && raw.idempotencyKey ? raw.idempotencyKey : `rev-${revision}`,
      savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
      // v1 speicherte den Nutzzustand direkt unter `payload` ODER als flaches Objekt.
      payload: 'payload' in raw ? raw.payload : { ...raw },
    };
  },
};

/** Erzeugt den Idempotenz-Schlüssel eines Stands (stabil je Revision). */
export function idempotencyKeyFor(revision: number, savedAt: number): string {
  return `rev-${revision}-${savedAt}`;
}

/**
 * Hebt einen rohen Umschlag auf die aktuelle Version. `null` nur, wenn die
 * Version unbekannt ist oder keine Migration existiert (ehrlich, kein Raten).
 */
export function migrateEnvelope(raw: unknown): SnapshotEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  let current = raw as RawRecord;
  let version = typeof current.schemaVersion === 'number' ? current.schemaVersion : 1;

  if (version > SNAPSHOT_SCHEMA_VERSION) return null; // Downgrade nicht unterstützt

  // v1-Stände ohne schemaVersion: `version` bleibt 1 → Migration greift.
  let guard = 0;
  while (version < SNAPSHOT_SCHEMA_VERSION) {
    const migrate = SNAPSHOT_MIGRATIONS[version];
    if (!migrate) return null;
    const next = migrate(current);
    if (!next) return null;
    current = next;
    const nextVersion = typeof current.schemaVersion === 'number' ? current.schemaVersion : version + 1;
    if (nextVersion <= version) return null; // keine Endlosschleife
    version = nextVersion;
    guard += 1;
    if (guard > 16) return null;
  }

  if (!('payload' in current)) return null;
  const revision = typeof current.revision === 'number' && Number.isFinite(current.revision) ? current.revision : 0;
  const savedAt = typeof current.savedAt === 'number' ? current.savedAt : 0;
  const key = typeof current.idempotencyKey === 'string' && current.idempotencyKey ? current.idempotencyKey : idempotencyKeyFor(revision, savedAt);
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, revision, idempotencyKey: key, savedAt, payload: current.payload };
}

/**
 * Baut den nächsten Umschlag: Revision + 1, neuer stabiler Schlüssel.
 * `previous` liefert die Revisionsbasis (auch nach einem Reload).
 */
export function nextEnvelope<T>(
  payload: T,
  options: { previous?: SnapshotEnvelope | null; savedAt?: number } = {},
): SnapshotEnvelope<T> {
  const previousRevision = options.previous?.revision;
  const revision = Number.isFinite(previousRevision) ? (previousRevision as number) + 1 : 1;
  const savedAt = options.savedAt ?? 0;
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    revision,
    idempotencyKey: idempotencyKeyFor(revision, savedAt),
    savedAt,
    payload,
  };
}

/** Serialisiert einen Umschlag für Storage/Transport. */
export function serializeEnvelope(envelope: SnapshotEnvelope): string {
  return JSON.stringify(envelope);
}

/** Liest einen serialisierten Umschlag inkl. Migration (defensiv). */
export function deserializeEnvelope(raw: string): SnapshotEnvelope | null {
  try {
    return migrateEnvelope(JSON.parse(raw));
  } catch {
    return null;
  }
}
