/**
 * audioMONASTRY · RLS-Vertrag: der Soll-Zustand und seine Prüfung
 * =================================================================
 * DB-P2-002 (2026-09-23).
 *
 * WARUM ES DIESE DATEI GIBT:
 * Am 2026-09-23 fiel beim ersten Live-Abgleich auf, dass die RLS-Härtung
 * `RC1-004` seit Iteration 2 committet im Repo lag, aber **nie auf die Datenbank
 * angewendet** worden war. Live erlaubte `anon` weiterhin SELECT auf 13 Tabellen,
 * darunter `system_prompts` (53 Zeilen) und `ai_evaluations` (285) — und der
 * anon-Key liegt im öffentlichen Client-Bundle.
 *
 * Alle Gates waren dabei **grün**: `tests/supabaseRls.test.ts` prüft die
 * MigrationsDATEIEN und konnte es deshalb nicht sehen. Eine Migrationsdatei ist
 * kein Vollzug. Es fehlte eine Prüfung, die Repo-Soll und Datenbank-Ist
 * gegeneinander hält — genau das ist diese Datei.
 *
 * Die Prüffunktion hier ist ABSICHTLICH rein (keine Datenbank, kein Netz): so ist
 * sie ohne Zugangsdaten testbar und kann im Beweis-Skript gegen echte Messwerte
 * laufen.
 */

/**
 * Der Vertrag. Änderungen hier sind eine Sicherheitsentscheidung, keine
 * Formatierung — jede zusätzliche Tabelle in `anonReadTables` gibt dem
 * öffentlichen Schlüssel Lesezugriff.
 */
export const RLS_CONTRACT = {
  /**
   * Tabellen, die der BROWSER mit dem anon-Key lesen darf.
   * Beleg für genau diese zwei: `src/lib/supabaseClient.ts` liest `samples`
   * (Zeile 73) und `music_tracks` (Zeile 85). Kein anderer Client-Pfad liest
   * eine Tabelle mit dem anon-Key (0 Treffer der übrigen Tabellennamen in
   * `dist/assets/*.js`).
   */
  anonReadTables: ['samples', 'music_tracks'] as const,
  /** Jede Tabelle im Schema public muss RLS aktiv haben. */
  requireRlsOnAllTables: true,
} as const;

/** Eine Zeile aus `public.rls_contract_report()`. */
export interface RlsReportRow {
  tablename: string;
  rls_enabled: boolean;
  policyname: string;
  policy_roles: string[] | null;
  policy_cmd: string;
  using_condition: string;
  check_condition: string;
}

export interface RlsSummary {
  tabellen: number;
  tabellenOhneRls: string[];
  anonLiest: string[];
  offenePolicies: number;
}

/** Ist diese Policy eine Lese-Erlaubnis (SELECT oder ALL) für `anon`? */
export function grantsAnonRead(row: RlsReportRow): boolean {
  const roles = row.policy_roles ?? [];
  if (!roles.includes('anon')) return false;
  return row.policy_cmd === 'SELECT' || row.policy_cmd === 'ALL';
}

/**
 * WICHTIG für die Bewertung: eine Policy, die formal für die Rolle `public`
 * gilt, ist NICHT automatisch ein Loch. Die `visual_*_service_only`-Policies
 * gelten für `public`, sind aber über
 * `auth.role() = 'service_role'` gesperrt. Wer nur die Rolle liest, hält sie
 * fälschlich für offen — dieser Fehlschluss ist mir am 2026-09-23 passiert.
 * Deshalb wird hier bewusst auf `anon`-Rollen geprüft und nicht auf `public`.
 */
export function summarizeRls(rows: readonly RlsReportRow[]): RlsSummary {
  const tabellen = new Set<string>();
  const tabellenOhneRls = new Set<string>();
  const anonLiest = new Set<string>();
  let offenePolicies = 0;

  for (const row of rows) {
    tabellen.add(row.tablename);
    if (!row.rls_enabled) tabellenOhneRls.add(row.tablename);
    if (grantsAnonRead(row)) {
      anonLiest.add(row.tablename);
      offenePolicies += 1;
    }
  }

  return {
    tabellen: tabellen.size,
    tabellenOhneRls: [...tabellenOhneRls].sort(),
    anonLiest: [...anonLiest].sort(),
    offenePolicies,
  };
}

/**
 * Vergleicht den gemessenen Zustand mit dem Vertrag. Rückgabe: die Liste der
 * Verstöße — leer heißt „Vertrag erfüllt". Bewusst keine Ausnahmen und keine
 * Toleranz: entweder die Menge stimmt oder nicht.
 */
export function checkRlsContract(
  rows: readonly RlsReportRow[],
  contract: { anonReadTables: readonly string[]; requireRlsOnAllTables: boolean } = RLS_CONTRACT,
): string[] {
  const verstoesse: string[] = [];
  if (rows.length === 0) {
    return ['Der Bericht ist leer — die Messung hat nichts geliefert (falsches Projekt? Funktion fehlt?).'];
  }

  const summary = summarizeRls(rows);

  // 1) anon-Lesemenge muss GENAU dem Vertrag entsprechen.
  const soll = [...contract.anonReadTables].sort();
  const ist = summary.anonLiest;
  const zuviel = ist.filter((t) => !soll.includes(t));
  const fehlt = soll.filter((t) => !ist.includes(t));

  if (zuviel.length > 0) {
    verstoesse.push(
      `anon darf LESEN, was es nicht darf: ${zuviel.join(', ')} — ` +
        `das ist eine Exposition gegenueber jedem, der das Client-Bundle hat.`,
    );
  }
  if (fehlt.length > 0) {
    verstoesse.push(
      `anon darf NICHT lesen, was der Browser braucht: ${fehlt.join(', ')} — ` +
        `die Anwendung wird an dieser Stelle brechen.`,
    );
  }

  // 2) RLS muss ueberall aktiv sein.
  if (contract.requireRlsOnAllTables && summary.tabellenOhneRls.length > 0) {
    verstoesse.push(`Tabellen ohne aktives RLS: ${summary.tabellenOhneRls.join(', ')}`);
  }

  return verstoesse;
}

/** Kurzbericht fuer die Konsole. */
export function formatRlsSummary(summary: RlsSummary, verstoesse: readonly string[]): string {
  const zeilen = [
    `Tabellen im Schema public: ${summary.tabellen}`,
    `davon ohne RLS:           ${summary.tabellenOhneRls.length === 0 ? 'keine' : summary.tabellenOhneRls.join(', ')}`,
    `anon-Lese-Policies:       ${summary.offenePolicies}`,
    `anon liest:               ${summary.anonLiest.join(', ') || '(keine)'}`,
  ];
  if (verstoesse.length > 0) {
    zeilen.push('', 'VERSTOESSE GEGEN DEN VERTRAG:', ...verstoesse.map((v) => `  - ${v}`));
  }
  return zeilen.join('\n');
}
