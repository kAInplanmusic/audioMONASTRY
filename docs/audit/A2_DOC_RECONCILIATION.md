# A2 – Dokumentationsabgleich, Runde 2

Stand: 2026-11-13 UTC. Status ⚠️: Dokumente abgeglichen, numerische Inventur- und Domain-DoD blockiert.

## Was geändert wurde

AGENTS.md §2.3, README, SERVER_FLEET und AI_FLEET_STARTPLAN unterscheiden
Provider-Konfiguration, historische Planung und tatsächlich belegtes Inventar.
Aktueller Produktionsbestand ausschließlich: `docs/SERVER_FLEET.md`.
Die A1-Übergabe wurde nach Abschluss gelesen; deren historische Registryeinträge
wurden nicht verändert. A1-Belege: `R2-A1-ACCESS`, `R2-A1-PROVIDER-SKIPS`,
`R2-A1-TOOL-1` bis `R2-A1-TOOL-3`; DNS `R2-A1-DNS-1257`, `1865`, `2424`.

Gelöschte Dokumentverweise wurden durch existierende Quellen ersetzt:
Startbedingungen/Manifestabgleich → `docs/AI_FLEET_STARTPLAN.md`,
Migration/MoA-Historie → `docs/VAST_MIGRATION_STATUS_2026-11-11.md`,
Gewichtespiegel-Anleitung → `docs/DEPLOY_READINESS.md` §1.
Der obsolete, nicht mehr vorhandene Auditpfad wurde aus der Wächter-Erlaubnisliste
entfernt; keine Assertion wurde geändert. Keine Ersatz-Stubs wurden erstellt.

## Belege und Historie

Neue Belege werden separat für die Integration bereitgestellt und ausschließlich
an `EVIDENCE_REGISTRY.json` angehängt. `R2-A2-HISTORY-SERVER-FLEET` sowie
`R2-A2-HISTORY-DOMAIN-01` bis `09` enthalten tatsächlich ausgeführte
`git show 8a2f1f9:<Datei>` mit Datum und Originalausgabe. Archivierte Abschnitte
sind in den Dokumenten durch eindeutige Registry-Verweise ersetzt; es wurden
keine alten Domainnamen in vermeintliche neue Messergebnisse umgeschrieben.
Prüfung auf Private-Key-Blöcke, Bearerwerte und verbreitete Tokenpräfixe vor
Speicherung: keine Treffer. Neue HTTP-Belege redigieren sensible Headerwerte
bei Vorkommen als `[REDACTED]`; keine solchen Werte wurden beobachtet.

## Domainprüfung und Runtime-Änderungen

`R2-A2-DOMAIN-01` bis `12`: echtes BIND dig für A/AAAA/CNAME, anschließend
`curl --connect-timeout 5 --max-time 15 -sI https://<Host>`, 09:41:46–09:41:58 UTC.
TLS-Verifikation blieb aktiv. Der vorgeschaltete HTTP/1.1-200-CONNECT-Status
ist kein Originstatus. Alle curl-Aufrufe endeten mit Exit 0; curl ohne `-f`
behandelt HTTP 503 nicht als Prozessfehler.

| Vorgeschlagenes Ziel | DNS A / AAAA | letzter HEAD-Status | Bewertung |
| --- | --- | --- | --- |
| hallerbans.de | 104.21.78.253, 172.67.138.231 / 2606:4700:3034::ac43:8ae7, 2606:4700:3037::6815:4efd | HTTP/2 200, text/html, Cloudflare | HTTPS-Antwort erhalten; keine App-Health- oder GPU-Aussage |
| origin.hallerbans.de | 135.181.111.103 / kurze Ausgabe leer | HTTP/2 503 | Dienst nicht als gesund erreichbar |
| sfu.hallerbans.de | 135.181.251.14 / kurze Ausgabe leer | HTTP/2 503 | Dienst nicht als gesund erreichbar |

Kurze leere CNAME-Ausgaben beweisen keinen fehlenden Record; gemäß A1 liefert
der Resolver NOTIMP, der CNAME-Status bleibt unbekannt. Leere AAAA-Ausgaben
sind mit den recordtypspezifischen A1-Statusheadern zu lesen.

**Keine Domain-Defaults geändert.** Origin/SFU sind ungesund; der Apex-HTML-
Status beweist keine gesunde Studio-App. Keine DNS-, Deployment-, Container-
oder Provideränderungen. Die Anpassungen in Python/JSON/TypeScript betreffen
nur Dokumentverweise bzw. einen Diagnosehinweis, keine Routing-/Audiofunktion.
Keine neue Audiolatenz; Vier-Nutzer-Synchronisation und B2B-Lock unverändert.

## DoD und Prüfungen

- `R2-A2-LEGACY-GREP`: exakter vom Nutzer verlangter rekursiver grep ausgeführt,
  mit Datum und vollständiger Originalausgabe. **6 Treffer verbleiben** in
  `deploy/layouts/2-4-instance/docker-compose.4instance.yml` (24, 38, 69),
  `docker-compose.overrides.app.yml` (15, 17) und `docker-compose.2instance.yml` (42).
  Das sind bewusst unangetastete Runtime-Defaults. Nulltreffer-DoD daher ⚠️.
- `R2-A2-GPU-GREP`: vier Pflichtdokumente geprüft; aktuelle Gesamtbestandsangabe
  ausschließlich im kanonischen Dokument. Numerische Übereinstimmung mit A1 ist
  mangels authentifizierter Inventur nicht herstellbar; DoD ⚠️.
- `npm exec --package=node@22 -- node node_modules/vitest/vitest.mjs run tests/docReferences.test.ts tests/moaBoundary.test.ts`:
  beide Dateien grün. Originalausgabe: `R2-A2-DOC-TESTS`.
- `python3 -m unittest tests.test_hetzner_scripts.ServertypRollenDriftTest`:
  4 Tests, OK (`R2-A2-SERVER-TYPES`).
- Zusätzlich `tests/aiLegacyEndpointExample.test.ts` ausgeführt: 3/4 grün;
  bestehender Wächter lehnt drei historische P0-Logdateien ab, die den alten
  HF-Vorlagenpfad nennen. Betroffen: `docs/audit/p0/all-tests.log`,
  `checkpoint-focused-actual.log`, `final-tests.log`. Nicht umgeschrieben,
  keine Erlaubnis hinzugefügt; Integration archiviert Originalbelege separat.
- `NODE_OPTIONS=--use-env-proxy npm exec --package=node@22 -- npm run verify`
  vollständig aufgerufen: typecheck grün; lint stoppt mit bekanntem ungenutztem
  Argument `i`, `src/components/spatial/SpatialClubSetup.tsx:97:35`.
  Exit 1. Durch die &&-Kette nicht erreicht: test, test:python, security,
  audio:gate, audit:rt:gate, test:rls, check:deadfiles, audit:deep:static,
  verify:summary. Kein vollständiges Verify-Grün beansprucht.
- `git diff --check`: grün (`R2-A2-DIFF-CHECK-FINAL`).

## Offene Punkte

Authentifizierten Produktionszugang und SSH-Agent bereitstellen, dann Inventur
wiederholen. Gesunde Origin-/SFU-/App-Endpunkte belegen, bevor neue Defaults
übernommen werden. Laufende Kosten bleiben ungeklärt. Der bekannte Spatial-
Lintfehler liegt außerhalb A2. Abschließendes Verify auf dem Integrationsbranch
ist erforderlich; A2 behauptet keine Freigabe.
