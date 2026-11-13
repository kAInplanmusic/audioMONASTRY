# A2 – Dokumentabgleich und Domainmigration

Status: ⚠️ Teilerfüllung. Basis `main` = `5193d9e33142c00edd67712fc2f605a722e66db7`.
Branch: `fix/a2-doc-reconciliation`. Prüfung: 2026-11-13T07:23:26.938769+00:00.

## Getan

- A1 meldete den abschließenden Bestand als unbekannt. `AGENTS.md:54–55`,
  `README.md:3` und `docs/SERVER_FLEET.md:3` verweisen nun auf
  `docs/INFRA_INVENTORY_STATUS.md`. Dort wird der unbekannte aktuelle GPU-Bestand
  mit den A1-IDs `A1-access-preflight`, `A1-provider-hetzner` und
  `A1-provider-runpod` belegt. A1s Registry ist eine Integrationsabhängigkeit
  dieses separat von main abgezweigten Branches.
- Unbelegte aktuelle Hardware-/Pod-Zahlen aus den zentralen Aussagen entfernt;
  alte Betriebs- und Modellpläne ausdrücklich als historische, nicht live
  bestätigte Planung markiert. Bestehende ausführbare GPU-Konfigurationen
  bleiben unangetastet. Keine Behauptung einer vollständig bereinigten Spec.
- Domain auf `hallerbans.de` migriert, einschließlich Subdomains und historischer
  Dokumentation. Jedes bearbeitete historische Dokument weist ausdrücklich
  darauf hin, dass redaktionell migrierte alte Ausgaben keine Originalbelege
  mehr sind; Originale sind in der Git-Historie. Neue A1-Originalbelege wurden
  nicht verändert.

## Vorherige Code-/Config-Treffer und Laufzeitwirkung

Vor Änderung per `git grep -n` mit dem alten Domainstamm geprüft. Sechs
Config-Stellen, keine weiteren kleingeschriebenen Domain-Treffer im Runtime-Code:

| Datei:Zeile | Geänderter Default | Wirkung bei Nutzung des Layouts ohne Override |
|---|---|---|
| `deploy/layouts/2-4-instance/docker-compose.2instance.yml:42` | ORIGIN_HOST | Origin-Host nun `origin.hallerbans.de` |
| `deploy/layouts/2-4-instance/docker-compose.4instance.yml:24` | SFU_SIGNALING_URL | Signaling nun `https://sfu.hallerbans.de` |
| `deploy/layouts/2-4-instance/docker-compose.4instance.yml:38` | DOMAIN | Domain nun `hallerbans.de` |
| `deploy/layouts/2-4-instance/docker-compose.4instance.yml:69` | DOMAIN | SFU-Domain nun `sfu.hallerbans.de` |
| `deploy/layouts/2-4-instance/docker-compose.overrides.app.yml:15` | DOMAIN | Domain nun `hallerbans.de` |
| `deploy/layouts/2-4-instance/docker-compose.overrides.app.yml:17` | SFU_SIGNALING_URL | Signaling nun `https://sfu.hallerbans.de` |

Nur Dateidiffs, kein Deploy/DNS-Eingriff oder Containerstart. Commit dieser
Config-Änderungen: `f40d7ed` (`A2: migrate legacy layout domain defaults to hallerbans.de`).

## DoD und Verifikation

Domain-DoD-Befehl wurde im A2-Worktree ausgeführt. Unten ist der Suchbegriff nur
in zwei Shell-Teile zerlegt, damit die Dokumentation den Suchtreffer nicht selbst
erzeugt; die Shell übergibt dasselbe Wort wie im Nutzerbefehl:

```sh
grep -rn anunnaki""tools . --exclude-dir=.git --exclude-dir=node_modules
```

Originalausgabe: leer. Exit-Code: `1` (grep: keine Treffer). Dies gilt für den
A2-Branch vor Integration von A1. **Für den integrierten Stand ist die Forderung
nach null Treffern blockiert:** A1 muss die damals geprüften alten Domainnamen
in Befehlen und Original-DNS-Ausgaben unverändert bewahren. Diese Belege zu
ersetzen würde die Beweisintegrität verletzen. Keine Null-Treffer-Behauptung für
den integrierten Stand.

```sh
rg -n 'GPU-Anzahl|INFRA_INVENTORY_STATUS' AGENTS.md README.md docs/SERVER_FLEET.md docs/INFRA_INVENTORY_STATUS.md
```

Ausgabe enthält die zentrale unbekannte Bestandsangabe nur in
`docs/INFRA_INVENTORY_STATUS.md:3`; die drei Hauptdocs enthalten Verweise.
**Numerische GPU-DoD bleibt blockiert:** A1 hat keinen aktuellen GPU-Messwert.
Historische Zahlen und geplante Ressourcen stehen weiterhin in anderen Dateien.
Eine repo-weite „GPU-Zahl in genau einer Datei“-Erfüllung wird nicht behauptet.
Reproduzierbarer Gegenbeleg für verbliebene historische Zählaussagen:

```sh
git grep -l -E '8[- ×x]*(GPU|Pods)|acht (RunPod|48-GB)|Fuenf RunPod' -- '*.md'
```

Originalausgabe:

```text
AUDIT_MASTER_REPORT.md
DEPLOY.md
docs/ANALYSE_openDAW_ACE-Step_2026-10-12.md
scripts/visual-vorrat/BERICHT.md
```

Gezielte bestehende Tabellen-Regressionsprüfung:

```sh
python3 tests/test_hetzner_scripts.py ServertypRollenDriftTest -v
```

Originalschlussausgabe:

```text
Ran 4 tests in 0.009s

OK
```

`git diff --check`: exit `0`, Ausgabe leer.

`npm run verify`: exit `127`, früh im typecheck abgebrochen. Originalschluss:

```text
> audioMONASTRY@1.210.001 typecheck
> tsc --noEmit

sh: 1: tsc: not found
```

Keine vollständige Gate-Freigabe; Dependencies fehlen im A2-Worktree. Die Domain-
und Dokumentänderungen ändern keine DSP-/Session-/Lock-Implementierung (Diff).

## Offene Punkte / außerhalb Scope

- Lesender Provider-/Host-Zugang erforderlich für aktuellen vollständigen
  Inventarstand und numerische GPU-SSOT.
- Historische Ressourcenlimits, Zielpläne und ausführbare GPU-Manifeste sind
  weiterhin mehrere Quellen mit Zahlen. Ohne aktuellen A1-Bestand nicht
  spekulativ vereinheitlicht oder operativ umgestellt.
- Großgeschriebene Organisations-/Hugging-Face-Namespace- und lokale Pfadnamen
  aus der Vorprüfung sind keine `.de`-Domain. Diese umzubenennen würde neue
  Registry-/Dateisystemziele erfinden und liegt außerhalb des Auftrags.
- Keine Live-Erreichbarkeit, Zertifikate oder korrekte DNS-Zielzuweisung der
  neuen Domains durch A2 nachgewiesen. Keine Infrastrukturänderung ausgeführt.

Geänderte Dateien: `git diff --name-only main...fix/a2-doc-reconciliation` nach
Commit zeigt die vollständige Liste; drei Compose-Dateien, die drei Hauptdocs,
Inventory-Status, dieser Bericht und die historischen Dokumente mit Domain-Treffern.
