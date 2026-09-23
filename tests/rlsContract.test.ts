/**
 * DB-P2-002: der RLS-Vertrag und seine Prüfung.
 *
 * Warum es diese Tests gibt: am 2026-09-23 lag eine fertige RLS-Härtung im Repo
 * und war nie angewendet worden — alle Gates blieben grün, weil sie nur Dateien
 * prüften. Diese Tests sichern die Prüffunktion ab, die diesen Fall künftig
 * aufdeckt. Sie laufen OHNE Datenbank (die Prüffunktion ist rein), damit sie
 * überall laufen können — auch dort, wo keine Zugangsdaten liegen.
 *
 * Lauf: npx vitest run tests/rlsContract.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  RLS_CONTRACT,
  checkRlsContract,
  formatRlsSummary,
  grantsAnonRead,
  summarizeRls,
  parseMigrationSql,
  mergeMigrationState,
  type RlsReportRow,
} from '../server/rlsContract';

/** Baut eine Berichtszeile mit sinnvollen Vorgaben. */
function row(over: Partial<RlsReportRow>): RlsReportRow {
  return {
    tablename: 'samples',
    rls_enabled: true,
    policyname: 'anon_read_samples',
    policy_roles: ['anon'],
    policy_cmd: 'SELECT',
    using_condition: 'true',
    check_condition: '',
    ...over,
  };
}

/** Der Vertrag als gültiger Bericht: anon liest genau samples + music_tracks. */
const VERTRAGSGEMAESS: RlsReportRow[] = [
  row({ tablename: 'samples', policyname: 'anon_read_samples' }),
  row({ tablename: 'samples', policyname: 'service_write_samples', policy_roles: ['service_role'], policy_cmd: 'ALL' }),
  row({ tablename: 'music_tracks', policyname: 'anon_read_music' }),
  row({ tablename: 'ai_jobs', policyname: 'service_write_ai_jobs', policy_roles: ['service_role'], policy_cmd: 'ALL' }),
  row({ tablename: 'mcp_audit_events', policyname: 'service_write_mcp_audit', policy_roles: ['service_role'], policy_cmd: 'ALL' }),
];

describe('RLS-Vertrag: der gültige Zustand', () => {
  it('meldet keine Verstoesse, wenn anon genau samples und music_tracks liest', () => {
    expect(checkRlsContract(VERTRAGSGEMAESS)).toEqual([]);
  });

  it('haelt die Vertragsmenge fest', () => {
    expect([...RLS_CONTRACT.anonReadTables].sort()).toEqual(['music_tracks', 'samples']);
  });
});

describe('RLS-Vertrag: der Fall RC1-004 wird erkannt', () => {
  it('schlaegt an, wenn anon eine weitere Tabelle lesen darf', () => {
    // Genau der gemessene Zustand vom 2026-09-23: system_prompts war fuer anon lesbar.
    const mitLoch = [...VERTRAGSGEMAESS, row({ tablename: 'system_prompts', policyname: 'anon_read_system_prompts' })];
    const verstoesse = checkRlsContract(mitLoch);
    expect(verstoesse).toHaveLength(1);
    expect(verstoesse[0]).toContain('system_prompts');
    expect(verstoesse[0]).toContain('Client-Bundle');
  });

  it('erkennt ALL als Leseerlaubnis, nicht nur SELECT', () => {
    const mitAll = [...VERTRAGSGEMAESS, row({ tablename: 'ai_evaluations', policy_cmd: 'ALL' })];
    expect(checkRlsContract(mitAll)[0]).toContain('ai_evaluations');
  });

  it('schlaegt an, wenn der Browser eine gebrauchte Tabelle NICHT mehr lesen darf', () => {
    // Die andere Richtung: eine zu strenge Haertung bricht die Anwendung.
    const zuStreng = VERTRAGSGEMAESS.filter((r) => r.tablename !== 'music_tracks' || !grantsAnonRead(r));
    const verstoesse = checkRlsContract(zuStreng);
    expect(verstoesse.join(' ')).toContain('music_tracks');
    expect(verstoesse.join(' ')).toContain('wird an dieser Stelle brechen');
  });

  it('schlaegt an, wenn eine Tabelle kein aktives RLS hat', () => {
    // Synthetischer Name, absichtlich kein echter: diese Zeile beschreibt einen
    // erfundenen Zustand, und ein realer Tabellenname wuerde hier eine falsche
    // Faehrte legen (library_links etwa ist am 2026-09-23 entfernt worden).
    const ohneRls = [...VERTRAGSGEMAESS, row({ tablename: 'beispiel_tabelle', policyname: '', policy_roles: [], policy_cmd: '', rls_enabled: false })];
    expect(checkRlsContract(ohneRls).join(' ')).toContain('beispiel_tabelle');
  });

  it('verweigert ein Urteil bei leerem Bericht', () => {
    // Ein leeres Ergebnis ist kein bestandener Vertrag, sondern ein fehlender Messwert.
    expect(checkRlsContract([])[0]).toContain('leer');
  });
});

describe('RLS-Vertrag: die Rolle allein ist kein Urteil', () => {
  /**
   * Diese Tests halten einen eigenen Fehlschluss fest. Die Policies
   * `visual_*_service_only` gelten formal fuer die Rolle `public`, sind aber
   * ueber `auth.role() = 'service_role'` gesperrt. Am 2026-09-23 habe ich sie
   * beim ersten Hinsehen fuer offen gehalten - falsch. Der Vertrag prueft
   * deshalb auf die Rolle `anon`, nicht auf `public`.
   */
  it('wertet eine public-Policy mit service_role-Bedingung NICHT als Loch', () => {
    const visual = row({
      tablename: 'visual_generations',
      policyname: 'visual_generations_service_only',
      policy_roles: ['public'],
      policy_cmd: 'ALL',
      using_condition: "(auth.role() = 'service_role'::text)",
      check_condition: "(auth.role() = 'service_role'::text)",
    });
    expect(grantsAnonRead(visual)).toBe(false);
    expect(checkRlsContract([...VERTRAGSGEMAESS, visual])).toEqual([]);
  });

  it('erkennt public+anon gemeinsam als Loch', () => {
    const offen = row({ tablename: 'visual_feedback', policy_roles: ['public', 'anon'], policy_cmd: 'ALL' });
    expect(grantsAnonRead(offen)).toBe(true);
    expect(checkRlsContract([...VERTRAGSGEMAESS, offen])[0]).toContain('visual_feedback');
  });
});

describe('RLS-Vertrag: Zusammenfassung', () => {
  it('zaehlt Tabellen, fehlendes RLS und anon-Policies', () => {
    const summary = summarizeRls([
      ...VERTRAGSGEMAESS,
      row({ tablename: 'beispiel_tabelle', policyname: '', policy_roles: [], policy_cmd: '', rls_enabled: false }),
    ]);
    expect(summary.tabellen).toBe(5);
    expect(summary.tabellenOhneRls).toEqual(['beispiel_tabelle']);
    expect(summary.anonLiest).toEqual(['music_tracks', 'samples']);
  });

  it('formatiert einen lesbaren Bericht und nennt Verstoesse', () => {
    const rows = [...VERTRAGSGEMAESS, row({ tablename: 'system_prompts' })];
    const text = formatRlsSummary(summarizeRls(rows), checkRlsContract(rows));
    expect(text).toContain('Tabellen im Schema public: 5');
    expect(text).toContain('VERSTOESSE GEGEN DEN VERTRAG');
    expect(text).toContain('system_prompts');
  });
});

// ============================================================================
// DB-P2-002, Nachtrag: die Richtung DATEI -> DATENBANK
// ============================================================================
// Bis hierher prüfte der Vertrag nur das Ist der Datenbank. Genau der Fall, der
// am 2026-09-23 passiert ist, blieb damit unsichtbar: eine Migration lag fertig
// im Repo und war NIE angewendet worden - die Dateien sahen dabei fehlerfrei aus.
// Diese Tests sichern die Gegenrichtung ab, ohne eine Datenbank zu brauchen.

describe('DB-P2-002 · Migrationsdateien gegen den Live-Zustand', () => {
  const datei = (name: string, sql: string) => ({ name, sql });

  /** Eine Live-Zeile bauen (nur die Felder, die die Prüfung liest). */
  const live = (tabellen: { name: string; policies?: { name: string; roles: string[]; cmd: string }[] }[]): RlsReportRow[] => {
    const rows: RlsReportRow[] = [];
    for (const t of tabellen) {
      if (!t.policies || t.policies.length === 0) {
        rows.push({
          tablename: t.name,
          rls_enabled: true,
          policyname: '',
          policy_roles: null,
          policy_cmd: '',
          using_condition: '',
          check_condition: '',
        });
        continue;
      }
      for (const p of t.policies) {
        rows.push({
          tablename: t.name,
          rls_enabled: true,
          policyname: p.name,
          policy_roles: p.roles,
          policy_cmd: p.cmd,
          using_condition: '',
          check_condition: '',
        });
      }
    }
    return rows;
  };

  it('erkennt eine Migration, die im Repo liegt und nie angewendet wurde (Fall RC1-004)', () => {
    const dateien = [
      datei('001_basis.sql', 'create table public.samples (id text);\ncreate policy "anon_read_samples" on public.samples for select to anon using (true);'),
      datei('002_neu.sql', 'create table public.system_prompts (id uuid);\ncreate policy "service_prompts" on public.system_prompts for all to service_role using (true);'),
    ];
    // Live fehlt system_prompts samt Policy - die Datenbank hat 002 nie gesehen.
    const rows = live([{ name: 'samples', policies: [{ name: 'anon_read_samples', roles: ['anon'], cmd: 'SELECT' }] }]);
    const verstoesse = checkRlsContract(rows, undefined, { dateien });
    expect(verstoesse.join('\n')).toContain('system_prompts');
    expect(verstoesse.join('\n')).toContain('eine Datei ist kein Vollzug');
    expect(verstoesse.join('\n')).toMatch(/service_prompts@system_prompts/);
  });

  it('erkennt eine Policy, die im Repo entfernt wurde und live noch steht', () => {
    const dateien = [
      datei('001_basis.sql', 'create table public.samples (id text);\ncreate policy "anon_read_samples" on public.samples for select to anon using (true);\ncreate policy "anon_read_tags" on public.sample_tags for select to anon using (true);'),
      datei('002_haerten.sql', 'drop policy if exists "anon_read_tags" on public.sample_tags;'),
    ];
    const rows = live([
      { name: 'samples', policies: [{ name: 'anon_read_samples', roles: ['anon'], cmd: 'SELECT' }] },
      { name: 'sample_tags', policies: [{ name: 'anon_read_tags', roles: ['anon'], cmd: 'SELECT' }] },
    ]);
    const verstoesse = checkRlsContract(rows, undefined, { dateien });
    expect(verstoesse.join('\n')).toMatch(/anon_read_tags@sample_tags/);
    expect(verstoesse.join('\n')).toContain('Haertung ist nicht angekommen');
  });

  it('rechnet die Reihenfolge richtig: spaeter wieder angelegt heißt SOLL vorhanden', () => {
    const dateien = [
      datei('001_basis.sql', 'create table public.samples (id text);\ncreate policy "p" on public.samples for select to anon using (true);'),
      datei('002_weg.sql', 'drop policy if exists "p" on public.samples;'),
      datei('003_wieder.sql', 'create policy "p" on public.samples for select to anon using (true);'),
    ];
    // music_tracks gehoert mit dazu: der Vertrag verlangt GENAU {samples, music_tracks}
    // als anon-Ziele, sonst meckert Pruefung 1 zu Recht.
    const rows = live([
      { name: 'samples', policies: [{ name: 'p', roles: ['anon'], cmd: 'SELECT' }] },
      { name: 'music_tracks', policies: [{ name: 'q', roles: ['anon'], cmd: 'SELECT' }] },
    ]);
    expect(checkRlsContract(rows, undefined, { dateien })).toEqual([]);
  });

  it('loescht mit einer Tabelle auch deren Policies aus der Erwartung (kein Fehlalarm)', () => {
    // Genau der Fall library_links: 012 legt an, 015 loescht wieder. Der erste
    // Entwurf meldete hier faelschlich "Tabelle fehlt in der Datenbank".
    const dateien = [
      datei('012_library_tables.sql', 'create table public.library_links (id text);\ncreate policy "service_write_links" on public.library_links for all to service_role using (true);'),
      datei('015_drop_library_links.sql', 'drop table if exists public.library_links cascade;'),
    ];
    const rows = live([{ name: 'samples', policies: [{ name: 'anon_read_samples', roles: ['anon'], cmd: 'SELECT' }] }]);
    const verstoesse = checkRlsContract(rows, undefined, { dateien });
    expect(verstoesse.join('\n')).not.toContain('library_links');
    // Der Vertrag selbst meckert weiter, weil samples als anon-Ziel fehlt -
    // das ist gewollt und zeigt, dass die Pruefung nicht einfach still ist.
    expect(verstoesse.length).toBeGreaterThan(0);
  });

  it('ohne Migrationsdateien wird nur das Ist geprueft (Vertrag bleibt nutzbar)', () => {
    const rows = live([{ name: 'samples', policies: [{ name: 'a', roles: ['anon'], cmd: 'SELECT' }] }, { name: 'music_tracks', policies: [{ name: 'b', roles: ['anon'], cmd: 'SELECT' }] }]);
    expect(checkRlsContract(rows)).toEqual([]);
  });

  it('erkennt ein fehlendes create table auch ohne Policy', () => {
    const dateien = [datei('001.sql', 'create table public.nur_tabelle (id text);')];
    const rows = live([{ name: 'samples', policies: [{ name: 'a', roles: ['anon'], cmd: 'SELECT' }] }, { name: 'music_tracks', policies: [{ name: 'b', roles: ['anon'], cmd: 'SELECT' }] }]);
    expect(checkRlsContract(rows, undefined, { dateien }).join('\n')).toContain('nur_tabelle');
  });
});

describe('DB-P2-002 · der Migrationsleser selbst', () => {
  it('liest die Anweisungen in TEXTREIHENFOLGE, nicht nach Art gruppiert', () => {
    const ereignisse = parseMigrationSql(
      [
        'create table if not exists public.a (id text);',
        'create policy "p1" on public.a for select to anon using (true);',
        'drop policy if exists "p1" on public.a;',
        'create policy "p1" on public.a for select to anon using (true);',
      ].join('\n'),
    );
    expect(ereignisse.map((e) => e.art)).toEqual(['tabelle+', 'policy+', 'policy-', 'policy+']);
  });

  it('ueberliest Kommentarzeilen', () => {
    const ereignisse = parseMigrationSql(
      ['-- create table public.falle (id text);', '-- drop policy if exists "x" on public.samples;', 'create table public.echt (id text);'].join('\n'),
    );
    expect(ereignisse).toHaveLength(1);
    expect(ereignisse[0]).toMatchObject({ art: 'tabelle+', name: 'echt' });
  });

  it('setzt die Dateien in alphabetischer Reihenfolge zusammen (wie Supabase anwendet)', () => {
    const zustand = mergeMigrationState([
      { name: '010_danach.sql', sql: 'drop table if exists public.weg;' },
      { name: '001_zuerst.sql', sql: 'create table public.weg (id text);\ncreate table public.bleibt (id text);' },
    ]);
    expect(zustand.tables).toEqual(['bleibt']);
  });

  it('nimmt bei einem drop table auch dessen Policies aus der Erwartung', () => {
    const zustand = mergeMigrationState([
      { name: '001.sql', sql: 'create table public.t (id text);\ncreate policy "p" on public.t for all to service_role using (true);' },
      { name: '002.sql', sql: 'drop table if exists public.t cascade;' },
    ]);
    expect(zustand.erwartetVorhanden).toEqual([]);
    expect(zustand.tables).toEqual([]);
  });
});
