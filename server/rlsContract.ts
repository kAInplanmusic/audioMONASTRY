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
 * Ein Verweis auf eine Policy: Tabelle + Name.
 */
export interface PolicyRef {
  table: string;
  name: string;
}

/**
 * Der Zustand, den die Migrationsdateien BESCHREIBEN.
 *
 * Bis zum 2026-09-23 wurde nur das Ist (Datenbank) geprueft. Damit blieb genau
 * der Fall unsichtbar, der passiert war: eine Migration lag im Repo und war nie
 * angewendet worden. Der Abgleich braucht beide Richtungen.
 */
export interface MigrationState {
  /** Tabellen, die die Migrationen anlegen. */
  tables: string[];
  /** Policies, die nach Abzug aller Drops uebrig bleiben SOLLEN. */
  erwartetVorhanden: PolicyRef[];
  /** Policies, die die Migrationen entfernt haben - sie duerfen live NICHT sein. */
  erwartetWeg: PolicyRef[];
}

/** Ein Ereignis in einer Migrationsdatei, in der Reihenfolge des Textes. */
type Ereignis =
  | { art: 'tabelle+'; name: string }
  | { art: 'tabelle-'; name: string }
  | { art: 'policy+'; ref: PolicyRef }
  | { art: 'policy-'; ref: PolicyRef };

/**
 * Liest die relevanten Anweisungen aus einem SQL-Text - IN DER REIHENFOLGE des
 * Textes, nicht nach Art gruppiert.
 *
 * WARUM DIE REIHENFOLGE ZWINGEND IST (eigener Fehler, 2026-09-23):
 * Der erste Entwurf sammelte alle `create table` und alle `drop policy` ein und
 * rechnete sie getrennt auf. `supabase/migrations/012_library_tables.sql` legt
 * `library_links` an, `015_drop_library_links.sql` loescht sie wieder - der
 * Abgleich meldete daraufhin "Tabelle fehlt in der Datenbank" und schlug Alarm,
 * obwohl der Zustand RICHTIG war. Ein Fehlalarm im Gate ist genauso schlimm wie
 * ein uebersehener Fehler: danach glaubt niemand mehr dem gruenen Lauf.
 *
 * Bewusst textuell: die Dateien sind handgeschriebenes SQL. Was hier nicht
 * erkannt wird, fehlt im Vergleich - deshalb sind die Muster an den
 * Schreibweisen ausgerichtet, die in `supabase/migrations/` wirklich vorkommen.
 */
export function parseMigrationSql(sql: string): Ereignis[] {
  const ohneKommentare = sql
    .split('\n')
    .filter((zeile) => !zeile.trim().startsWith('--'))
    .join('\n');

  const muster: { re: RegExp; bau: (m: RegExpMatchArray) => Ereignis }[] = [
    {
      re: /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi,
      bau: (m) => ({ art: 'tabelle+', name: m[1].toLowerCase() }),
    },
    {
      re: /drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi,
      bau: (m) => ({ art: 'tabelle-', name: m[1].toLowerCase() }),
    },
    {
      re: /create\s+policy\s+"?([^"\s]+)"?\s+on\s+(?:public\.)?"?([a-z0-9_]+)"?/gi,
      bau: (m) => ({ art: 'policy+', ref: { name: m[1].toLowerCase(), table: m[2].toLowerCase() } }),
    },
    {
      re: /drop\s+policy\s+(?:if\s+exists\s+)?"?([^"\s]+)"?\s+on\s+(?:public\.)?"?([a-z0-9_]+)"?/gi,
      bau: (m) => ({ art: 'policy-', ref: { name: m[1].toLowerCase(), table: m[2].toLowerCase() } }),
    },
  ];

  const ereignisse: { pos: number; e: Ereignis }[] = [];
  for (const { re, bau } of muster) {
    for (const m of ohneKommentare.matchAll(re)) {
      ereignisse.push({ pos: m.index ?? 0, e: bau(m) });
    }
  }
  return ereignisse.sort((a, b) => a.pos - b.pos).map((x) => x.e);
}

/**
 * Fuehrt die Dateien in Anwendungsreihenfolge zusammen (alphabetisch, wie
 * Supabase Migrationen anwendet) und wendet die Ereignisse der Reihe nach an.
 *
 * Zwei Faelle, die die Reihenfolge braucht:
 *   * `007_rls_harden` entfernt eine Policy, die eine spaeter sortierte Datei
 *     wieder anlegt - dann SOLL sie existieren.
 *   * `015_drop_library_links` loescht eine Tabelle, die `012` angelegt hat -
 *     dann darf weder die Tabelle noch eine ihrer Policies erwartet werden.
 */
export function mergeMigrationState(
  dateien: readonly { name: string; sql: string }[],
): MigrationState {
  const tabellen = new Set<string>();
  const tabellenWeg = new Set<string>();
  const policies = new Map<string, PolicyRef>();
  const policiesWeg = new Map<string, PolicyRef>();

  for (const datei of [...dateien].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const e of parseMigrationSql(datei.sql)) {
      if (e.art === 'tabelle+') {
        tabellen.add(e.name);
        tabellenWeg.delete(e.name);
      } else if (e.art === 'tabelle-') {
        tabellen.delete(e.name);
        tabellenWeg.add(e.name);
        // Mit der Tabelle verschwinden ihre Policies (ON DELETE CASCADE bzw.
        // implizit): sie duerfen nicht mehr erwartet werden.
        for (const key of [...policies.keys()]) {
          if (key.startsWith(`${e.name}|`)) policies.delete(key);
        }
      } else if (e.art === 'policy+') {
        policies.set(`${e.ref.table}|${e.ref.name}`, e.ref);
        policiesWeg.delete(`${e.ref.table}|${e.ref.name}`);
      } else {
        policies.delete(`${e.ref.table}|${e.ref.name}`);
        policiesWeg.set(`${e.ref.table}|${e.ref.name}`, e.ref);
      }
    }
  }

  const sortiere = (a: PolicyRef, b: PolicyRef) => `${a.table}${a.name}`.localeCompare(`${b.table}${b.name}`);
  return {
    tables: [...tabellen].sort(),
    erwartetVorhanden: [...policies.values()].sort(sortiere),
    erwartetWeg: [...policiesWeg.values()].sort(sortiere),
  };
}

/**
 * Policies, die in den Dateien per `drop` entfernt werden und danach NICHT
 * wieder angelegt werden. Sie duerfen in der Datenbank nicht mehr stehen.
 */
export function nieWiederAngelegt(dateien: readonly { name: string; sql: string }[]): PolicyRef[] {
  return mergeMigrationState(dateien).erwartetWeg;
}

/**
 * Vergleicht den gemessenen Zustand mit dem Vertrag. Rückgabe: die Liste der
 * Verstöße — leer heißt „Vertrag erfüllt". Bewusst keine Ausnahmen und keine
 * Toleranz: entweder die Menge stimmt oder nicht.
 *
 * `migrationen` ist optional: ohne sie wird nur das Ist geprueft (so laufen die
 * Tests ohne Dateisystem). Mit ihr kommt die Richtung Datei -> Datenbank dazu.
 */
export function checkRlsContract(
  rows: readonly RlsReportRow[],
  contract: { anonReadTables: readonly string[]; requireRlsOnAllTables: boolean } = RLS_CONTRACT,
  migrationen?: { dateien: readonly { name: string; sql: string }[] },
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

  // 3) RICHTUNG DATEI -> DATENBANK. Ohne diese Pruefung bleibt genau der Fall
  //    unsichtbar, der am 2026-09-23 passiert ist: eine Migration liegt im Repo,
  //    wurde aber nie angewendet. Die Dateien sahen dabei fehlerfrei aus.
  if (migrationen) {
    const dateien = migrationen.dateien;
    const soll = mergeMigrationState(dateien);
    const liveTabellen = new Set(rows.map((r) => r.tablename.toLowerCase()));
    const livePolicies = new Set(rows.map((r) => `${r.tablename.toLowerCase()}|${(r.policyname || '').toLowerCase()}`));

    const fehlendeTabellen = soll.tables.filter((t) => !liveTabellen.has(t));
    if (fehlendeTabellen.length > 0) {
      verstoesse.push(
        `Tabellen aus den Migrationen fehlen in der Datenbank: ${fehlendeTabellen.join(', ')} — ` +
          `eine Datei ist kein Vollzug.`,
      );
    }

    const fehlendePolicies = soll.erwartetVorhanden.filter((p) => !livePolicies.has(`${p.table}|${p.name}`));
    if (fehlendePolicies.length > 0) {
      const liste = fehlendePolicies.map((p) => `${p.name}@${p.table}`).join(', ');
      verstoesse.push(
        `Policies stehen in den Migrationen, fehlen aber live: ${liste} — ` +
          `genau der Fall RC1-004 (Migration committet, nie angewendet).`,
      );
    }

    const wiederDa = nieWiederAngelegt(dateien).filter((p) => livePolicies.has(`${p.table}|${p.name}`));
    if (wiederDa.length > 0) {
      const liste = wiederDa.map((p) => `${p.name}@${p.table}`).join(', ');
      verstoesse.push(
        `Policies wurden in den Migrationen entfernt, sind live aber noch da: ${liste} — ` +
          `die Haertung ist nicht angekommen.`,
      );
    }
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
