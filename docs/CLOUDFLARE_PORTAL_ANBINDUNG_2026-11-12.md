# Cloudflare-Portal für hallerbans.de

Stand: 12. November 2026. Die DNS-Zone ist aktiv; delegiert an `hal.ns.cloudflare.com` und `vera.ns.cloudflare.com`, Tarif Free Website.

## Veröffentlichte Anbindung

- Worker: `audiomonastry-portal`, auf `hallerbans.de/*` und `www.hallerbans.de/*`.
- `www` leitet mit HTTP 308 auf die Hauptdomain weiter. HTTP wird am Cloudflare-Einstieg auf HTTPS umgeleitet; Origin-TLS-Modus ist Strict.
- Neues Origin-Zertifikat für `hallerbans.de` und `*.hallerbans.de`, Ablauf 12. November 2027. Der private Schlüssel und alle Zugangsdaten bleiben ausschließlich in privater Umgebung und verschlüsselten Worker-Bindings.
- Bestehende Portal-Benutzer-, Passwort-, Session- und Studio-Bindings bleiben erhalten. Neue/aktualisierte DNS-, R2-, Registry- und Vast-Einstellungen werden nur serverseitig übergeben.
- Portal- und Studio-Cookie werden als getrennte Secure-/HttpOnly-Set-Cookie-Header gesetzt. Signierte Sessions unterstützen Administratornamen mit Punkten, beispielsweise E-Mail-Adressen.

## App-Kaltstart

Der erste Start auf der neuen Domain verwendet `PORTAL_FRESH_BOOTSTRAP=1`. Vorhandene Snapshots werden dabei nicht gelöscht, aber für diesen Startweg nicht verwendet: Sie können noch frühere Domains, Zertifikate oder Providerkonfigurationen enthalten. Nach einer vollständigen Abnahme können passende frische Snapshots vorbereitet und der Schalter bewusst zurückgenommen werden.

Der Quellbranch ist `fix/model-weight-provisioning-20261110`; ein vollständiger `EXPECTED_COMMIT` pinnt den ausgecheckten Stand zusätzlich unveränderlich. Die Build-Metadaten kommen aus dem tatsächlich ausgecheckten Repository. Damit ändern spätere Branch-Commits nicht unbemerkt den freigegebenen Kaltstart.

Nur app-1 erhält Vast-/Registry-Zugang und die KI-Runtime-Authentifizierung. Das Providerprofil bleibt Vast mit maximal 8 EUR/h für die GPU-Flotte, ohne Hetzner/Supabase. Öffentliche Supabase-URL und Anon-Key werden auch für den Frontend-Build gesetzt; der Service-Role-Key wird nicht in Frontend-Variablen gespiegelt. SFU erhält die eigene Signalisierungsadresse und TURN-Konfiguration.

Beim Einschalten werden `origin.hallerbans.de`, `sfu.hallerbans.de` und `master.hallerbans.de` aus den beobachteten öffentlichen App-/SFU-/Media-Adressen verdrahtet. Für noch nicht angelegte Dienste werden keine Zieladressen erfunden. Der Media-Kaltstart verwendet den vorhandenen Master-Player-Dienst. DNS-Namen allein sind kein Nachweis für laufende Dienste oder eine fertige Medien-Abnahme.

## Verifikation und Grenzen

70 gezielte Portaltests sowie Typecheck und ESLint bestanden. Abgedeckt sind unter anderem DNS- und Rollenübergabe, unveränderliche Bootstrap-Revision, Snapshot-Erhalt, Schutz fremder reservierter IPs und der Login-/Cookie-Rundlauf. Ein vollständig grüner Gesamtprüflauf der Anwendung wird damit nicht behauptet.

Der öffentliche HTTPS-Einstieg liefert das Portal; `/api/status` meldet ohne Sitzung `off`/`locked`, ein unauthentifizierter POST auf `/api/wake` wird mit HTTP 401 abgewiesen. Der Standard-User-Agent von Python urllib wurde von Cloudflare mit 1010 abgewiesen; ein ausdrücklich als `audioMONASTRY-DeploymentCheck/1.0` gekennzeichneter Anwendungscheck funktioniert entsprechend Cloudflares dokumentierter Empfehlung. Schutzfunktionen wurden dafür nicht abgeschaltet.

In diesem Schritt wurden keine CPU-/GPU-Instanzen angelegt und kein kostenpflichtiger Wake ausgeführt. Ein echter Kaltstart bis zur fertigen DAW, Viernutzer-Livebetrieb und die vollständige Vast-Inferenzabnahme bleiben gesondert zu prüfen. Modelle, Gewichte, Revisionen und Qualitätsparameter wurden nicht geändert.

## Verbleibender IP-Kostenrest

Die bisherige reservierte Hetzner-IPv4 wurde nicht freigegeben. Die automatische Sicherheitsprüfung lehnte die zusätzliche Umstellung der Apex-/Origin-Records auf eine Dokumentationsadresse ab, weil sie Origin-Verkehr stören könnte und nicht ausdrücklich beauftragt war. Die anschließende lesende Prüfung bestätigte die bisherigen Ziele: Hauptdomain und Origin zeigen weiterhin auf `78.47.218.180`, `www` auf die Hauptdomain. Deshalb wird kein vollständig kostenfreier Ruhezustand des gesamten Kontos behauptet.

Der Abschaltpfad gibt nur noch der Anwendung zugeordnete Floating-IPs frei; fremde Projektadressen werden nicht mehr pauschal gelöscht. Snapshot-Sicherung vor dem Löschen bleibt erhalten.
