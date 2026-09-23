/**
 * Ruhestandswaechter fuer Geheimnisse (`SEC-P1-005`, 2026-09-23).
 *
 * WARUM ES DIESEN TEST GIBT
 * -------------------------
 * Zweimal stand im Register "entfernt", waehrend der Wert noch auf der Platte
 * lag:
 *
 *   * `SEC-P1-002` und `ENV-006` (beide DONE) behaupteten: "danach liegt kein
 *     Cloudflare-Token mehr auf der Platte."
 *   * `SEC-P1-005` (2026-09-23 gemessen): `CF_API_TOKEN` lag wieder in `.env`
 *     UND in zwei `.env.bak-*`-Dateien.
 *
 * Eine Beseitigung, die niemand nachmisst, ist eine Behauptung. Genau derselbe
 * Fehlertyp wie bei der RLS-Haertung (`DB-P2-002`): die Arbeit lag im Repo, der
 * Vollzug fehlte. Dieser Test ist der fehlende Messpunkt - er laeuft bei jedem
 * `npm run verify` mit und braucht keine Zugangsdaten.
 *
 * WAS ER PRUEFT
 * -------------
 * Fuer jeden zurueckgezogenen Schluessel gilt: in keiner `.env*`-Datei des
 * Repos darf ein WERT stehen. Der NAME darf vorkommen (in Kommentaren, in
 * Vorlagen) - nur eben ohne Wert.
 *
 * Ein erneutes Eintragen ist eine bewusste Entscheidung, kein Versehen: Wer den
 * Wert wirklich braucht, traegt ihn per `npx wrangler secret put <NAME>` in den
 * Dienst ein (nicht in eine Datei) oder nimmt den Schluessel hier mit Begruendung
 * aus der Liste. Was nicht passieren soll: dass er stillschweigend zurueckkommt.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface RetiredSecret {
  /** Name der Umgebungsvariablen. */
  key: string;
  /** Warum sie zurueckgezogen wurde - erscheint in der Fehlermeldung. */
  reason: string;
}

/**
 * Zurueckgezogene Schluessel. Quelle der Liste: `docs/ENV_MATRIX.md`
 * ("Gültigkeitsmessung 2026-09-17" + Korrektur 2026-09-23).
 *
 * AENDERUNG 2026-09-23: `CF_API_TOKEN` ist hier ENTFERNT worden.
 *
 * Warum: der Betreiber hat am 2026-09-23 bewusst entschieden, wieder
 * Cloudflare-Zugangsdaten in die `.env` zu legen (private Forschungsmaschine,
 * keine oeffentliche Instanz). Ein Waechter, der eine bewusste Entscheidung
 * blockiert, wird umgangen statt beachtet - dann schuetzt er auch die uebrigen
 * Schluessel nicht mehr. Genau diesen Weg beschreibt die Fehlermeldung unten.
 *
 * Der neue Wert wurde VOR dem Eintragen gemessen (GET /user/tokens/verify ->
 * HTTP 200, status active) und die R2-Zugangsdaten wurden live geprueft
 * (HeadBucket + ListObjectsV2 gegen den echten Bucket). Der Schutz gilt weiter
 * fuer die vier toten Schluessel - und die Regel bleibt: kein Geheimnis in eine
 * committete Datei.
 */
const RETIRED: RetiredSecret[] = [
  { key: 'CFR2_API_TOKEN', reason: 'HTTP 401 (Code 1000) - tot, kein Repo-Konsument' },
  { key: 'CF_ACCESS_TOKEN', reason: 'HTTP 401 (Code 1000) - tot, kein Repo-Konsument' },
  { key: 'CFR2_API_KEY', reason: 'nicht pruefbar, kein Repo-Konsument' },
  { key: 'COMET_API_KEY', reason: 'gehoert zur externen Deep-Code-Integration, nicht zum Repo' },
];

/** Platzhalter gelten NICHT als Wert - sonst waeren Vorlagen unbrauchbar. */
const PLATZHALTER = /^(<.*>|\.\.\.|changeme|change-me|example|dummy|xxx+|platzhalter|your[-_]?token|none|null|todo)$/i;

/** Ist der Wert echt (kein Platzhalter, nicht leer)? */
export function hatEchtenWert(rohwert: string): boolean {
  const wert = rohwert.trim().replace(/^["']|["']$/g, '').trim();
  if (wert === '') return false;
  return !PLATZHALTER.test(wert);
}

/** Alle `.env*`-Dateien im Repo-Wurzelverzeichnis (keine Unterordner). */
function envDateien(): string[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.startsWith('.env'))
    .map((e) => e.name)
    .sort();
}

interface Fund {
  datei: string;
  key: string;
}

/** Sucht zurueckgezogene Schluessel MIT Wert. Nur Dateiname + Schluessel, nie der Wert. */
export function findeWiederkehr(): Fund[] {
  const funde: Fund[] = [];
  for (const datei of envDateien()) {
    const inhalt = readFileSync(path.join(ROOT, datei), 'utf8');
    for (const zeile of inhalt.split('\n')) {
      const treffer = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(zeile);
      if (!treffer) continue;
      const [, key, wert] = treffer;
      if (!RETIRED.some((r) => r.key === key)) continue;
      if (hatEchtenWert(wert)) funde.push({ datei, key });
    }
  }
  return funde;
}

describe('SEC-P1-005 · zurueckgezogene Geheimnisse bleiben zurueckgezogen', () => {
  it('kein zurueckgezogener Schluessel hat einen Wert in einer .env-Datei', () => {
    const funde = findeWiederkehr();
    const meldung = funde
      .map((f) => {
        const grund = RETIRED.find((r) => r.key === f.key)?.reason ?? 'unbekannt';
        return `  ${f.datei}: ${f.key} hat wieder einen Wert (${grund})`;
      })
      .join('\n');

    expect(
      funde,
      funde.length === 0
        ? ''
        : `\nEin zurueckgezogenes Geheimnis ist zurueckgekehrt:\n${meldung}\n\n` +
            'Was zu tun ist: Wert entfernen (Zeile auf `NAME=` setzen und den Grund als Kommentar\n' +
            'stehen lassen) und den alten Wert beim Anbieter widerrufen. Wird der Wert wirklich\n' +
            'gebraucht, dann per `npx wrangler secret put NAME` in den Dienst - nicht in eine Datei.\n',
    ).toEqual([]);
  });

  it('findet die zurueckgezogenen Schluessel auch wirklich (Gegenprobe der Suche)', () => {
    // Sonst koennte der Test gruen sein, weil er nichts findet, weil er nichts SUCHT.
    // Der Waechter muss einen Schluessel kennen, den es noch gibt - sonst prueft er nichts.
    expect(RETIRED.map((r) => r.key)).toContain('COMET_API_KEY');
    expect(RETIRED.map((r) => r.key)).not.toContain('CF_API_TOKEN');
    expect(hatEchtenWert('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2')).toBe(true);
    expect(hatEchtenWert('')).toBe(false);
    expect(hatEchtenWert('"   "')).toBe(false);
    expect(hatEchtenWert('<hier-eintragen>')).toBe(false);
    expect(hatEchtenWert('changeme')).toBe(false);
  });

  it('prueft mindestens eine .env-Datei (sonst misst der Test nichts)', () => {
    expect(envDateien().length).toBeGreaterThan(0);
  });
});
