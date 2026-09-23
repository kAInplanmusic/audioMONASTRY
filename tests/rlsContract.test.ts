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
