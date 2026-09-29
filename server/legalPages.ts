/**
 * audioMONASTRY · Rechtstexte als eigenständige, token-freie Seiten
 * =================================================================
 * Veröffentlicht `/impressum` und `/datenschutz` (PROD-P0-005).
 *
 * WARUM NICHT ALS REACT-ROUTE:
 * Die App ist ein einseitiges Studio OHNE URL-Routen (kein react-router).
 * Rechtstexte gehören dort nicht hin - sie müssen OHNE JavaScript, ohne
 * Studio-Zugang und ohne Konto lesbar sein. Eine Datenschutzerklärung hinter
 * einem Token wäre wertlos: wer sie lesen will, hat den Zugang noch nicht.
 * Deshalb liefert der Server zwei schlanke HTML-Dokumente aus.
 *
 * WARUM DIE ANGABEN AUS DER UMGEBUNG KOMMEN:
 * Anschrift, Name und Kontakt sind Betreiber-Angaben, keine Code-Angaben. Sie
 * stehen in `LEGAL_*`-Variablen, damit das Ausfüllen keinen Code-Änderung und
 * kein Deployment eines neuen Images braucht. Fehlt eine PFLICHTANGABE, zeigt
 * die Seite das sichtbar an (siehe unten) - sie behauptet keine Anschrift, die
 * sie nicht hat.
 *
 * WARUM KEINE EXTERNEN RESSOURCEN:
 * Diese Seiten dürfen NICHTS nachladen - keine Schriftart, kein Skript, kein
 * Bild von einem Dritten. Eine Datenschutzerklärung, die beim Aufruf eine
 * Verbindung zu Google Fonts aufbaut, widerlegt sich selbst. Alles Styling ist
 * eingebettet; die CSP erlaubt das (`style-src 'self' 'unsafe-inline'`,
 * server/csp.ts:247). Ein Test prüft, dass keine externe Ressource referenziert
 * wird (`tests/legalPages.test.ts`).
 *
 * PFLICHTANGABEN UND EHRLICHKEIT:
 * § 5 DDG verlangt Name und Anschrift. Solange diese fehlen, ist die Seite
 * NICHT vollständig - das wird oben als deutlicher Hinweis angezeigt, statt eine
 * leere oder erfundene Angabe zu rendern. Eine erfundene Anschrift wäre
 * schlimmer als keine: sie ist falsch UND haftungsrelevant.
 */

import type { Express } from 'express';

/** Öffentliche Pfade. Bewusst NICHT unter `/api` - dort greift die Token-Sperre. */
export const LEGAL_PATHS = ['/impressum', '/datenschutz'] as const;
export type LegalPath = (typeof LEGAL_PATHS)[number];

export interface LegalOperator {
  /** Name oder Firma, wie sie lauten soll. */
  name: string;
  street: string;
  city: string;
  country: string;
  email: string;
  phone: string;
  /** Verantwortlich für den Inhalt / Vertretungsberechtigter. */
  represent: string;
  /** Zuständige Aufsichtsbehörde (Art. 13 DSGVO). */
  supervisory: string;
}

/** Dieselben Schlüssel, die `operatorFromEnv` liest - für Doku und Tests. */
export const LEGAL_ENV_KEYS: Record<keyof LegalOperator, string> = {
  name: 'LEGAL_NAME',
  street: 'LEGAL_STREET',
  city: 'LEGAL_CITY',
  country: 'LEGAL_COUNTRY',
  email: 'LEGAL_EMAIL',
  phone: 'LEGAL_PHONE',
  represent: 'LEGAL_REPRESENT',
  supervisory: 'LEGAL_SUPERVISORY',
};

export function operatorFromEnv(env: Record<string, string | undefined> = {}): LegalOperator {
  const read = (key: keyof LegalOperator): string => String(env[LEGAL_ENV_KEYS[key]] ?? '').trim();
  return {
    name: read('name'),
    street: read('street'),
    city: read('city'),
    country: read('country'),
    email: read('email'),
    phone: read('phone'),
    represent: read('represent'),
    supervisory: read('supervisory'),
  };
}

/**
 * Welche Pflichtangaben nach § 5 DDG fehlen? Name, Anschrift und eine
 * erreichbare E-Mail sind nicht weglassbar; Telefon ist optional.
 */
export function missingMandatoryFields(op: LegalOperator): string[] {
  const missing: string[] = [];
  if (!op.name) missing.push('Name/Firma (LEGAL_NAME)');
  if (!op.street) missing.push('Straße und Hausnummer (LEGAL_STREET)');
  if (!op.city) missing.push('PLZ und Ort (LEGAL_CITY)');
  if (!op.country) missing.push('Land (LEGAL_COUNTRY)');
  if (!op.email) missing.push('E-Mail (LEGAL_EMAIL)');
  return missing;
}

/** HTML-Escaping. Die Werte kommen aus der Umgebung - ohne das wäre das ein XSS-Pfad. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1.25rem 4rem; background: #0a0d12; color: #e6edf3;
         font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 76ch; margin: 0 auto; }
  h1 { font-size: 1.6rem; letter-spacing: .02em; margin: 0 0 .35rem; }
  h2 { font-size: 1.12rem; margin: 2rem 0 .5rem; color: #7fe3ff; }
  h3 { font-size: 1rem; margin: 1.4rem 0 .35rem; }
  p, li { color: #c3ccd6; }
  a { color: #7fe3ff; }
  code { background: #151b23; padding: .1em .35em; border-radius: 4px; font-size: .92em; }
  table { border-collapse: collapse; width: 100%; margin: .75rem 0; font-size: .93rem; }
  th, td { border: 1px solid #222c38; padding: .5rem .6rem; text-align: left; vertical-align: top; }
  th { background: #131a22; color: #e6edf3; }
  nav { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1.25rem 0 2rem;
         padding-bottom: 1rem; border-bottom: 1px solid #1d2733; font-size: .9rem; }
  .warn { border: 1px solid #7a4a00; background: #2a1c00; color: #ffd79a;
          padding: .85rem 1rem; border-radius: 8px; margin: 1rem 0 1.5rem; }
  .warn strong { color: #ffbe4d; }
  .warn ul { margin: .5rem 0 0; padding-left: 1.2rem; }
  .box { border: 1px solid #1d2733; background: #0e141b; border-radius: 8px;
         padding: .9rem 1.1rem; margin: .75rem 0 1.25rem; }
  .muted { color: #8b97a5; font-size: .9rem; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #1d2733;
           color: #8b97a5; font-size: .85rem; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="index, follow">
<title>${escapeHtml(title)} · audioMONASTRY</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<nav>
  <a href="/impressum">Impressum</a>
  <a href="/datenschutz">Datenschutz</a>
</nav>
${body}
<footer>
  audioMONASTRY · privates Forschungs- und Entwicklungsprojekt ·
  <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a>
</footer>
</main>
</body>
</html>
`;
}

function incompleteWarning(op: LegalOperator): string {
  const missing = missingMandatoryFields(op);
  if (missing.length === 0) return '';
  return `  <div class="warn">
    <strong>Diese Seite ist noch unvollständig.</strong>
    Nach § 5 DDG (vormals § 5 TMG) sind Name und Anschrift zwingend. Es fehlen:
    <ul>${missing.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>
    <span class="muted">Die Angaben werden über Umgebungsvariablen gesetzt
    (<code>LEGAL_*</code>) — kein Code-Änderung nötig. Diese Seite verschwindet, sobald die
    Pflichtangaben gesetzt sind.</span>
  </div>
`;
}

/** Anschrift-Block: zeigt echte Werte oder ehrlich "noch nicht eingetragen". */
function addressBlock(op: LegalOperator): string {
  const lines = [op.name, op.street, op.city, op.country].filter((v) => v !== '');
  if (lines.length === 0) {
    return '  <div class="box"><span class="muted">Noch nicht eingetragen (siehe Hinweis oben).</span></div>\n';
  }
  return `  <div class="box">${lines.map((l) => escapeHtml(l)).join('<br>')}</div>\n`;
}

export function renderImpressum(op: LegalOperator): string {
  const contact: string[] = [];
  if (op.email) contact.push(`E-Mail: <a href="mailto:${escapeHtml(op.email)}">${escapeHtml(op.email)}</a>`);
  if (op.phone) contact.push(`Telefon: ${escapeHtml(op.phone)}`);
  const contactHtml =
    contact.length > 0
      ? `  <div class="box">${contact.join('<br>')}</div>\n`
      : '  <div class="box"><span class="muted">Kontakt noch nicht eingetragen.</span></div>\n';

  const represent = op.represent
    ? `  <div class="box">${escapeHtml(op.represent)}</div>\n`
    : '  <div class="box"><span class="muted">Noch nicht eingetragen.</span></div>\n';

  return page(
    'Impressum',
    `${incompleteWarning(op)}<h1>Impressum</h1>
<p class="muted">Angaben gemäß § 5 DDG (vormals § 5 TMG)</p>

<h2>Anbieter</h2>
${addressBlock(op)}

<h2>Kontakt</h2>
${contactHtml}

<h2>Verantwortlich für den Inhalt</h2>
${represent}

<h2>Art des Angebots</h2>
<p>audioMONASTRY ist ein <strong>privates Forschungs- und Entwicklungsprojekt</strong> ohne
kommerzielle Zwecke. Es werden keine Waren oder Dienstleistungen verkauft und keine
Einnahmen erzielt. Das Projekt ist nicht öffentlich beworben; der Zugang ist
beschränkt und erfolgt über ein Zugangstoken. <span class="muted">Falls eine
Gewerbeanmeldung, Vereins- oder Gesellschaftsform besteht, gehört sie an diese Stelle —
„privat" ist keine Angabe im Sinne des § 5 DDG, sobald die Instanz öffentlich
erreichbar ist.</span></p>

<h2>Streitschlichtung</h2>
<p>Die Europäische Kommission stellt eine Plattform zur Online-Streitbeilegung bereit:
<a href="https://ec.europa.eu/consumers/odr/" rel="noopener noreferrer">ec.europa.eu/consumers/odr</a>.
Da kein kommerzielles Angebot betrieben wird, besteht keine Verpflichtung und keine
Bereitschaft zur Teilnahme an Streitbeilegungsverfahren vor einer
Verbraucherschlichtungsstelle.</p>

<h2>Haftung für Inhalte und Links</h2>
<p>Die Inhalte dieses Angebots werden mit Sorgfalt erstellt, sind aber ein
Forschungsstand ohne Gewähr. Für Inhalte externer Links sind ausschließlich deren
Betreiber verantwortlich; zum Zeitpunkt der Verlinkung waren keine Rechtsverstöße
erkennbar.</p>

<h2>Urheberrecht</h2>
<p>Die Software und die erstellten Inhalte sind urheberrechtlich geschützt. Es gilt die
Lizenz in der Datei <code>LICENSE</code> des Projekts. Eingebundene fremde Werke sind in
<code>docs/LICENSE_EXTERNAL_RESOURCES.md</code> einzeln aufgeführt.</p>
`,
  );
}

export function renderDatenschutz(op: LegalOperator): string {
  const supervisory = op.supervisory
    ? `  <div class="box">${escapeHtml(op.supervisory)}</div>\n`
    : `  <div class="box"><span class="muted">Noch nicht eingetragen. Bis dahin gilt: jede
Aufsichtsbehörde des gewöhnlichen Aufenthaltsorts kann angerufen werden
(Art. 77 DSGVO).</span></div>\n`;

  return page(
    'Datenschutz',
    `${incompleteWarning(op)}<h1>Datenschutzerklärung</h1>
<p class="muted">Informationen nach Art. 13 DSGVO</p>

<h2>1. Verantwortlicher</h2>
<p>Siehe <a href="/impressum">Impressum</a>.</p>

<h2>2. Welche Daten verarbeitet werden — und wo sie tatsächlich landen</h2>
<p>Die folgende Übersicht ist aus dem Quellcode und der eingesetzten Infrastruktur
abgeleitet, nicht aus einer Vorlage:</p>
<table>
<thead><tr><th>Datenkategorie</th><th>Zweck</th><th>Verarbeitungsort</th><th>Empfänger</th></tr></thead>
<tbody>
<tr><td>Audioaufnahme (Mikrofon, Instrument, Upload)</td><td>Kernfunktion: Aufnehmen, Mischen, Exportieren</td><td>Browser, eigener Server</td><td>Cloudflare R2 (Objektspeicher)</td></tr>
<tr><td><strong>Stimme</strong> (Sprachaufnahme, Voice-Generator)</td><td>Sprachfunktionen</td><td>eigener Server → GPU-Endpunkt</td><td>RunPod (GPU-Serverless), ggf. HuggingFace</td></tr>
<tr><td>Datei-Metadaten (Name, Tags, Tempo, Pfad)</td><td>Bibliothek, Suche</td><td>PostgreSQL</td><td>Supabase (Datenbankdienst)</td></tr>
<tr><td>Verbindungsdaten, IP-Adresse</td><td>Betrieb, Zugangsschutz, Missbrauchsabwehr</td><td>eigener Server, Protokolle</td><td>Hetzner (Hosting), Cloudflare (Proxy/DNS)</td></tr>
<tr><td>Anmelde-Cookies (<code>portal</code>, <code>studio</code>)</td><td>Sitzung, Zugangsschutz</td><td>Browser</td><td>— (kein Dritter)</td></tr>
<tr><td>Eingaben an KI-Funktionen</td><td>KI-Funktionen (Ideen, Presets, Analyse)</td><td>eigener Server → KI-Endpunkt</td><td>RunPod, HuggingFace, ggf. DeepSeek</td></tr>
<tr><td>Telemetrie (Nutzungs-/Fehlerdaten)</td><td>Stabilität</td><td>eigener Server</td><td>Prometheus/Grafana (eigene Instanz)</td></tr>
<tr><td>Lokale Zwischenspeicher (OPFS/IndexedDB)</td><td>Arbeiten ohne Netz</td><td><strong>ausschließlich im Browser</strong></td><td>—</td></tr>
</tbody>
</table>
<p><strong>Kernaussage:</strong> Die Audioarbeit bleibt im Browser und auf eigener
Infrastruktur. Es gibt <strong>keine</strong> Analyse-, Tracking- oder Werbe-Skripte
Dritter. Auch diese Seite lädt keine externe Ressource — keine Schriftart, kein Bild,
kein Skript von einem anderen Server.</p>

<h2>3. Besonderheit: Stimmdaten</h2>
<p>Wird die Stimme aufgenommen oder erzeugt, kann darin ein <strong>biometrisches Datum
nach Art. 9 DSGVO</strong> liegen. Ob das im Einzelfall so einzuordnen ist, hängt von der
Verwendung ab (Identifikation einer Person ja/nein) und ist rechtlich zu bewerten.
<span class="muted">Bewertung steht aus. Falls Art. 9 einschlägig ist, braucht es eine
ausdrückliche Einwilligung mit gesonderter Information — nicht nur diese
Erklärung.</span></p>

<h2>4. Übermittlung in Drittländer</h2>
<p>Die genannten Dienste (GPU-Serverless, Objektspeicher, Datenbank, Proxy) können Daten
außerhalb der EU verarbeiten. <span class="muted">Welche Länder das im Einzelnen sind und
worauf die Übermittlung gestützt wird (Angemessenheitsbeschluss oder
Standardvertragsklauseln), ist noch nicht abschließend geprüft und benannt. Diese
Angabe fehlt bewusst, statt eine Vermutung zu veröffentlichen.</span></p>

<h2>5. Rechtsgrundlagen</h2>
<p>Die Verarbeitung stützt sich je nach Vorgang auf die Erfüllung des Nutzungsverhältnisses
(Art. 6 Abs. 1 lit. b DSGVO), auf berechtigte Interessen an Betrieb und Sicherheit
(Art. 6 Abs. 1 lit. f DSGVO) oder auf Einwilligung (Art. 6 Abs. 1 lit. a DSGVO).
<span class="muted">Die Zuordnung je Verarbeitung ist noch zu vervollständigen.</span></p>

<h2>6. Speicherdauer</h2>
<p>Daten werden gelöscht, wenn der Zweck entfällt. Technisch vorhanden sind
Löschwege für gespeicherte Objekte, ein Zurücksetzen der Datenbank und
Zugriffsprotokolle. <span class="muted">Konkrete Fristen sind noch nicht festgelegt und
deshalb hier nicht genannt.</span></p>

<h2>7. Ihre Rechte</h2>
<p>Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der
Verarbeitung (Art. 18), Datenübertragbarkeit (Art. 20), Widerspruch (Art. 21), Widerruf
einer Einwilligung (Art. 7 Abs. 3) sowie Beschwerde bei einer Aufsichtsbehörde
(Art. 77). Für Auskunftsersuchen genügt eine Nachricht an die im
<a href="/impressum">Impressum</a> genannte Kontaktadresse.</p>

<h2>8. Zuständige Aufsichtsbehörde</h2>
${supervisory}

<h2>9. Keine automatisierte Entscheidungsfindung</h2>
<p>Es findet keine automatisierte Einzelentscheidung mit rechtlicher Wirkung nach
Art. 22 DSGVO statt. KI-Funktionen liefern Vorschläge; die Entscheidung trifft der
Mensch.</p>

<h2>10. Keine Benachrichtigungen, kein Profiling</h2>
<p>Die Anwendung sendet keine Benachrichtigungen an das Betriebssystem und legt kein
Nutzerprofil an. Es gibt keine Werbe- oder Analyse-Werkzeuge Dritter.</p>
`,
  );
}

/** Rendert eine der beiden Seiten. `null` heißt: unbekannter Pfad. */
export function renderLegalPage(path: string, op: LegalOperator): string | null {
  if (path === '/impressum') return renderImpressum(op);
  if (path === '/datenschutz') return renderDatenschutz(op);
  return null;
}

export function isLegalPath(path: unknown): path is LegalPath {
  return path === '/impressum' || path === '/datenschutz';
}

/**
 * Hängt die beiden Routen ein. Aufrufen VOR dem SPA-Fallback, sonst schluckt
 * der Fallback diese Pfade. Nicht unter `/api` aufhängen - dort greift die
 * Token-Sperre, und eine unzugängliche Datenschutzerklärung wäre wertlos.
 */
export function registerLegalRoutes(app: Express, env: Record<string, string | undefined> = {}): void {
  app.get([...LEGAL_PATHS], (req, res) => {
    const html = renderLegalPage(req.path, operatorFromEnv(env));
    if (!html) {
      res.status(404).type('text/plain').send('unbekannte Seite');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Kurz zwischenspeichern: die Betreiber-Angaben ändern sich selten, und ein
    // zwischengespeichertes Impressum ist besser als ein fehlendes.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(html);
  });
}
