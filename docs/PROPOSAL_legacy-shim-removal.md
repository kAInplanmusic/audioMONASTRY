# PROPOSAL · samplemonk-Legacy-Shim-Ausmusterung (REPO-VORBEREITUNG)

**Stand:** 2026-09-29, Basis `main @ d1fb16c` · **Autor:** Background-Worker (read-only Analyse + dieser Plan)
**Umfang:** Nur Repo. Kein Server-/Deploy-/API-Zugriff. Umsetzung später durch Betreiber/Haupt-Agent.

---

## 0. Ausgangslage (belegt)

* Renaming `samplemonk` → `audiomonastry` abgeschlossen (NOMEN-P1-001, SSOT item 69 DONE 2026-09-18).
* **Hetzner-Flotte: KOSTENSTOPP 2026-09-11, SSOT `fleetState2026_09_11.state = "GELOESCHT (Kostenstopp) - 0 Server, 0 Floating-IPs"`.** Zweitmessung 2026-09-21 (SSOT item 129): `/v1/servers 0`, `/v1/primary_ips 0`, `/v1/floating_ips 0`, `/v1/volumes 0`, **`/v1/firewalls 5` (alle kanonisch `audiomonastry-*`)**, 10 Snapshots (73,99 GB, 1,06 €/Monat) — fünf davon vom 2026-09-21, **fünf weitere mit Stand vom 09./18.09., deren Beschreibungen noch den Alt-Präfix tragen können** (dokumentiert in `docs/audit-infra-hetzner.md:135` und `docs/OPS_RUNBOOK.md:809,814`).
* Legacy-Firewalls (6× `samplemonk-*`) wurden 2026-09-20 per `cleanup-legacy-firewalls.py` gelöscht (SSOT item 129a, `docs/OPS_RUNBOOK.md:1269`). Der Altpfad `/opt/samplemonk` wurde auf ai-1 entfernt (`docs/OPS_RUNBOOK.md:1277`).
* Konsequenz: **Die Alt-Namen haben im Hetzner-Account keinen lebenden Server-/Firewall-/Pfad-/Projekt-Bezug mehr.** Einzige mögliche Restbestände: Alt-präfixte **Snapshots** (Kostenposten!) — siehe Phase 2 / Risiko R1.

---

## 1. Befund: alle aktiven Legacy-Shims (Zeilenbelege)

### 1.1 `scripts/hetzner/fleet-names.sh` (114 Zeilen) — die EINE Alt-Quelle
| Zeilen | Inhalt |
|---|---|
| 5–8, 12, 17–18, 24, 26–29 | Kommentare mit `samplemonk`-Literalen (Header, Beispiele) |
| 32 | `LEGACY_FLEET_PREFIX="${LEGACY_FLEET_PREFIX:-samplemonk-}"` |
| 44 | `LEGACY_COMPOSE_PROJECT="${LEGACY_COMPOSE_PROJECT:-samplemonk}"` |
| 51 | `LEGACY_FLEET_HOME="${LEGACY_FLEET_HOME:-/opt/samplemonk}"` |
| 61–63, 75–81 | Kommentare zur Zweit-Schreibweise |
| 66, 70–71 | `fleet_name()`: Legacy-Servername-Abfrage (zweiter API-Call) |
| 82–101 | `fleet_name_variants()`: Case-Zweige, die den Alt-Namen mitliefern |
| 110–111 | `fleet_legacy_compose_project()` |
| 113–114 | `fleet_legacy_home()` |

**Einziges `samplemonk`-Vorkommen unter `scripts/`** (gemessen: `grep -rln samplemonk scripts/hetzner/` → nur diese Datei) — genau die F10-Architektur „eine Quelle“.

### 1.2 Konsumenten der LEGACY-Variablen (brechen mit `set -u`, wenn Quelle entfernt wird!)
| Datei | Zeilen | Verwendung | Pflichtänderung |
|---|---|---|---|
| `scripts/hetzner/fleet-status.sh` | 61–63 | ALT-Projekt-Warnung via `$LEGACY_COMPOSE_PROJECT` | **JA** (set -uo pipefail) |
| `scripts/hetzner/fleet-status.sh` | 70–76 | Case-Muster `"${LEGACY_FLEET_PREFIX}"app-*` | **JA** |
| `scripts/hetzner/lifecycle.sh` | 79–83 | Env-Übergabe `LEGACY_FLEET_PREFIX=…` an Python-Retention | **JA** (set -uo pipefail; Zeile 83 referenziert die Variable) |
| `scripts/hetzner/fleet-deploy-live.sh` | 40–47, 79, 195 | `LEGACY_REMOTE_DIR="${DEPLOY_LEGACY_REMOTE_DIR:-$LEGACY_FLEET_HOME}"`, Print, Altpfad-Guard 224–235 | **JA** (set -euo pipefail) |
| `scripts/hetzner/migrate-project-name.sh` | 57, 101–105, 166, 173–176, 179–204, 260–262, 279–301, 332–334, 360–366 | **gesamtes Skript** = Alt-Projekt-/Pfad-Migration (`LEGACY_PROJECT="$LEGACY_COMPOSE_PROJECT"`) | **Datei löschen** (Zweck entfällt: 0 Knoten seit 2026-09-11/21; wiederhergestellte Flotten sind kanonisch) |
| `scripts/hetzner/cleanup-legacy-firewalls.py` | 45–58 (`legacy_prefix()` liest `$LEGACY_FLEET_PREFIX` aus fleet-names.sh) | Löscht ungenutzte Alt-Präfix-Firewalls | **Datei löschen** (Aufgabe erledigt 2026-09-20, Beleg SSOT item 129a + OPS_RUNBOOK 1260–1277) |
| `scripts/hetzner/delete-fleet.sh` | 26–27 (Kommentar), 108–111 (Print-Hinweis) | verweist auf cleanup-legacy-firewalls.py | JA (Text) |
| `scripts/hetzner/auto-repair.sh` | 38–48, 91–97, 136–141, 191–196 | nur `fleet_name_variants` (wird Passthrough) — **funktional unverändert lauffähig** | optional (Kommentare) |
| `scripts/hetzner/bring-up-fleet.sh` | 101–103, 165–170 | nur `fleet_name`/`fleet_candidates`/`fleet_compose_project` | NEIN (Passthrough greift) |
| `deploy.sh`, `scripts/hetzner/provision-fleet.sh`, `scripts/hetzner/firewall-ensure.py`, `scripts/hetzner/install-auto-repair.sh`, `scripts/hetzner/deliver-media.sh`, `scripts/hetzner/wire-scrape-token.sh` | — | sourcen fleet-names.sh, aber KEIN LEGACY-Bezug (gemessen) | NEIN |

### 1.3 `server/fleetWiring.ts` (121 Zeilen)
| Zeilen | Inhalt |
|---|---|
| 59–65 | Kommentar: Altname-Fallback-Begründung (NOMEN-P1-001) |
| 66 | `const FLEET_LEGACY_NAME_PREFIX = 'samplemonk-';` |
| 74–77 | `fleetNodeAddress()`: Legacy-Map-Fallback |

`fleetNodeAddress`-Signature bleibt (Aufrufer 103/105/109 unverändert); Rumpf kollabiert zu `return map[node];`.

### 1.4 `services/portal-worker/src/index.js` (2297 Zeilen)
| Zeilen | Inhalt | Phase |
|---|---|---|
| 20–23 | Kommentar „BEIDE Schreibweisen“ | 1 |
| 85–86 | `LEGACY_NAME_PREFIX = 'samplemonk-'` | 1 |
| 102–109 | `canonicalFleetName()`: Alt→Neu-Abbildung (einziger Aufrufer: `fleetServers()` Z. 165) | 1 |
| 737–743 | `syncAppFirewall()`: Firewall-Suche über `[audiomonastry-app, samplemonk-app]` | 1 |
| 1806–1816 | `serverRole()`: Rollen-Ableitung über beide Präfixe | 1 |
| 116–123 | `LEGACY_SNAPSHOT_PREFIXES = ['samplemonk-snapshot-']`, `ALL_SNAPSHOT_PREFIXES` | **2** |
| 189–194 | LIVE-BEFUND-Kommentar mit Literal `samplemonk-snapshot-app-2026-09-18[-live]` | 2 (ohne Literal umformulieren) |
| 196–199, 214–219 | `snapshotRoleOf()`/`findSnapshot()`: Schleifen über `ALL_SNAPSHOT_PREFIXES` | **2** |

Nicht anfassen (kein Fleet-Shim): `CFR2_*`-Spiegel (Z. 832–917) — das ist die R2-Env-Familie, separater Vertrag (`server/r2Config.ts`, `tests/portalWorkerR2EnvParity.test.ts`).

### 1.5 Tests
* `tests/fleetWiring.test.ts`: Z. 19–22 `legacyMap`-Fixture, Z. 58–59 Legacy-Fallback-Asserts, Z. 74–83 Test „verdrahtet auch eine Altflotte“.
* `tests/portalWorkerSnapshots.test.ts`: Alt-Namen in Fixtures Z. 24, 125, 204, 236, 261, 284–285, 352–355, 441, 496–497; Kompat-Block Z. 461–514 (Alt-Servernamen Z. 468–492 → Phase 1 entfällt; Alt-Snapshot-Test Z. 494–514 → Phase 2).
* `tests/test_hetzner_scripts.py`:
  * Z. 2568–2570 `LEGACY_FIXTURE_PROJECT/APP/CADDY`, Z. 2575–2579 `LEGACY_ALLOWED_FILES`, Z. 2607–2637 `FAKE_SSH` (Alt-Defaults 2627/2630), Z. 2961–2974 `_fake_ssh()`
  * `NamespaceParitaetTest`: Z. 2657–2669 (`_names()`-Probe mit legacy echoes), 2685–2699 (beide Schreibweisen), 2701–2706 (Override-Test, `bare.split()[1]`), 2788–2837 (Watchdog unter Altnamen), 2840–2846 (fleet-status-Muster), 2848–2869 (Altname-Scan)
  * Migrations-Tests Z. 2872–3042 (entfallen mit Skript); `FAKE_SSH`/`_fake_ssh` danach unbenutzt → löschen
  * Z. 3044–3095 Watchdog-usr-local-Test (Fixture auf kanonisch ziehen)
  * `FirewallWerkzeugeTest` Z. 451–483 (cleanup-legacy-firewalls-Prüfungen entfallen); Delete-Fleet-Assertions Z. 5933, 5967, 5975 (Marker `cleanup-legacy-firewalls.py` entfällt)
  * Z. 1138–1140 PROTECTED_ENV: `LEGACY_COMPOSE_PROJECT`, `LEGACY_FLEET_PREFIX`, `LEGACY_FLEET_HOME`, `DEPLOY_LEGACY_REMOTE_DIR` streichen

### 1.6 Wächter `tests/namingConventions.test.ts` — ALLOWED-Map (Z. 33–62)
**Entfallen (Datei danach altnamen-frei):**
| Zeile | Eintrag | Grund |
|---|---|---|
| 37 | `tests/fleetWiring.test.ts` | Fixture/Test entfällt |
| 38–40 | `tests/test_hetzner_scripts.py` | Fixtures/Assertions kanonisch |
| 41 | `services/portal-worker/src/index.js` | **erst in Phase 2** (Snapshot-Shims bleiben bis dahin) |
| 42–43 | `scripts/hetzner/fleet-names.sh` | Alt-Quelle entfernt |
| 44 | `server/fleetWiring.ts` | Fallback entfernt |
| 36 | `tests/portalWorkerSnapshots.test.ts` | **erst in Phase 2** |

**Neu aufnehmen:** `docs/PROPOSAL_legacy-shim-removal.md` — „Entfernungsplan mit Zeilenbelegen; nennt die Altnamen zwangsläufig (dieses Dokument).“

**Bleiben als BELEGE (Begründung je Zeile 34–62 unverändert gültig):** `MASTERTODOENDE.json` (SSOT-Historie), `docs/HETZNER_DEPLOY.md` (Migrationsliste Z. 595–660 bleibt), `docs/OPS_RUNBOOK.md` (Live-Kapitel 809/814/1269/1277), `docs/audit-infra-ARCHITEKTUR.md`, `docs/audit-infra-hetzner.md`, `docs/FIXPLAN_2026-09-20_externer_apptest.md`, `visualsUMSETZUNGSPLAN.md` (fremdes Projekt, „nicht anfassen“), `services/audiomonastry-ai-runtime/Dockerfile.manifest` (Alt-Basis-Image-ARG, Z. 32 — **außerhalb des Fleet-Shim-Scopes**, eigener Folgeauftrag), `tests/namingConventions.test.ts` (Wächter selbst).

**Zusätzlich im Wächter (Z. 158–162):** `expect(portal).toContain('LEGACY_SNAPSHOT_PREFIXES')` (Z. 162) entfällt in Phase 2; stattdessen Härtung: `expect(portal).not.toMatch(/samplemonk/i);`

### 1.7 Doku `docs/HETZNER_DEPLOY.md`
| Zeilen | Änderung |
|---|---|
| 685 | Tabellenzeile „EINE Namensquelle“: LEGACY_*/`fleet_legacy_home`-Anteil streichen |
| 690–700 | Block „akzeptieren beide Schreibweisen“ → „nur noch kanonisch“ (fleet-status/auto-repair/deploy-live beschreiben) |
| 709–727 | Trockenlauf-Belege: erwartete Ausgaben ohne Alt-Namen |
| 595–660 | **NICHT umschreiben** (Migrationsliste = Beleg); Nachtrag-Blockquote: „Nachtrag 2026-09-XX: Bestands-Kompatibilität entfernt (Flotte 2026-09-11 gestoppt/gelöscht, Alt-Firewalls 2026-09-20 gelöscht, Alt-Präfix-Snapshots siehe Phase 2)“ |
| 974–1032 | Migrations-How-to: als historisch markieren (Skript entfernt; Beleg: git-History + Audit-Dokus) |
| 1215, 1251 | `cleanup-legacy-firewalls.py`-Verweise: Nachtrag „Werkzeug entfernt, Aufgabe 2026-09-20 erledigt“ |

`docs/OPS_RUNBOOK.md` **nur lesen — bleibt unverändert als Beleg** (ALLOWED-Eintrag begründet das explizit).

---

## 2. Entfernungsplan (dateigenau)

### Phase 1 — Haupt-Ausrüstung (Ziele: 0 Server/Firewalls/Pfade/Projekte → sicher)
1. **`scripts/hetzner/fleet-names.sh`**
   * Löschen: Z. 32, 44, 51, 66, 70–71, 82–101 (Rumpf auf `printf '%s\n' "$canonical"` kollabieren), 110–111, 113–114.
   * Behalten: `FLEET_PREFIX` (31), `FLEET_COMPOSE_PROJECT` (43), `FLEET_HOME` (50), `fleet_server_count` (54–59), `fleet_name` (64–73, nur kanonische Abfrage), `fleet_candidates` (105, Alias — delete-fleet/lifecycle nutzen ihn weiter), `fleet_compose_project` (108).
   * Kommentare 5–8/12/17–18/24/26–29/61–63/75–81 auf kanonisch-einzig umschreiben (**kein** `samplemonk`-Literal übrig lassen, sonst bleibt die Datei im Wächter-Trefferbild).
2. **`scripts/hetzner/fleet-status.sh`**: Z. 61–63 löschen; Z. 70–76 Case zu `"${FLEET_PREFIX}"app-*` einschreinigen; Kommentar 68–70 anpassen.
3. **`scripts/hetzner/lifecycle.sh`**: Z. 83 `LEGACY_FLEET_PREFIX="$LEGACY_FLEET_PREFIX" \` streichen (Python Z. 91 filtert `None` bereits raus); Kommentar 79–80 anpassen.
4. **`scripts/hetzner/fleet-deploy-live.sh`**: Z. 40–47 Kommentar (fleet_legacy_home-Beispiel) umschreiben (DEPLOY_REMOTE_DIR-Override bleibt als Funktion); Z. 79 `LEGACY_REMOTE_DIR=…` löschen; Z. 195 Print-Zeile löschen; Z. 223–235 `LEGACY_INSTALL`-Guard löschen (Mismatch-Guard Z. 237–240 bleibt).
5. **`scripts/hetzner/migrate-project-name.sh`**: **Datei löschen** (372 Zeilen; einziger Zweck Alt-Bestand-Migration; 0 Knoten → ohne Ziel; Restore-Pfad `bring-up-fleet.sh --yes` erzeugt kanonisch).
6. **`scripts/hetzner/cleanup-legacy-firewalls.py`**: **Datei löschen** (liest `$LEGACY_FLEET_PREFIX` aus fleet-names.sh; Aufgabe 2026-09-20 erledigt, Beleg SSOT/OPS_RUNBOOK).
7. **`scripts/hetzner/delete-fleet.sh`**: Z. 26–27 Kommentar-Halbsatz + Z. 109–111 Print-Block zum Legacy-Firewall-Cleanup streichen.
8. **`server/fleetWiring.ts`**: Z. 59–66 löschen (Kommentar + Konstante); Z. 68–78 Rumpf zu `return map[node];`.
9. **`services/portal-worker/src/index.js` (nur Phase-1-Umfang)**: Z. 20–23 Kommentar kanonisch; Z. 85–86 löschen; Z. 102–109 zu `FLEET.some((f) => f.name === raw) ? raw : ''`; Z. 737–743 Firewall-Suche nur `${NAME_PREFIX}app`; Z. 1806–1816 Rollen-Ableitung nur `NAME_PREFIX`-Regex. **Snapshot-Shims (Z. 116–123, 189–199, 214–219) UNVERÄNDERT lassen (Phase 2).**
10. **Tests:** `tests/fleetWiring.test.ts` (Z. 19–22, 58–59, 74–83 entfallen; Rest bleibt — Direkt-Map-Verhalten wird weiter geprüft); `tests/test_hetzner_scripts.py` gem. §1.5 (Watchdog-Fixture kanonisch, Migrations-Tests + FAKE_SSH + `_fake_ssh` weg, `_names()`-Probe ohne legacy echoes, fleet-status-Muster einpräfixig, LEGACY_ALLOWED_FILES → `{index.js, Dockerfile.manifest}` in Phase 1); `tests/portalWorkerSnapshots.test.ts` nur Z. 24/125 (Servernamen kanonisch) + Z. 468–492 (Alt-Servernamen-Test) — **Snapshot-Fixtures bleiben Phase 2**.
11. **Wächter:** ALLOWED-Einträge Z. 37, 38–40, 42–43, 44 löschen; Z. 36 + 41 **stehen lassen** (Phase 2); Eintrag `docs/PROPOSAL_legacy-shim-removal.md` ergänzen.
12. **Doku:** `docs/HETZNER_DEPLOY.md` gem. §1.7.

### Phase 2 — bedingt: Alt-Snapshot-Erkennung (NUR nach Live-Verifikation)
**Vorbedingung (Betreiber, live — NICHT Teil dieses Repo-Auftrags):** Alt-präfixte Snapshots zählen und ggf. löschen:
```bash
set -a; . ./.env.deploy; set +a
curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" \
  "https://api.hetzner.cloud/v1/images?type=snapshot&per_page=100" \
  | python3 -c "import sys,json; [print(i['id'], i.get('name') or i.get('description')) for i in json.load(sys.stdin)['images']]"
```
Erwartung laut SSOT item 129 (Stand 2026-09-21): 10 Snapshots, davon **bis zu 5 mit Alt-Bezug** (Satz 09./18.09.). Erst wenn Bestand = 0 (oder bewusst als Verlust akzeptiert):
* `services/portal-worker/src/index.js`: Z. 116–123 (`LEGACY_SNAPSHOT_PREFIXES`, `ALL_SNAPSHOT_PREFIXES` → `[SNAPSHOT_PREFIX]`), Z. 189–199 Kommentar ohne Literal + Schleife in `snapshotRoleOf`, Z. 214–219 Schleife in `findSnapshot` (einpräfixig).
* `tests/portalWorkerSnapshots.test.ts`: Fixtures Z. 204/236/261/284–285/352–355/441/496–497 auf `audiomonastry-snapshot-*`; Z. 494–514 (Alt-Präfix-Test) löschen.
* `tests/test_hetzner_scripts.py`: `LEGACY_ALLOWED_FILES` → `{"services/audiomonastry-ai-runtime/Dockerfile.manifest"}`.
* Wächter: ALLOWED Z. 36 (`portalWorkerSnapshots`) + 41 (`index.js`) löschen; Z. 162 `LEGACY_SNAPSHOT_PREFIXES`-Assert ersetzen durch `expect(portal).not.toMatch(/samplemonk/i);`.

### Optionale Begleitung (verhält sich identisch, nur Text)
* `scripts/hetzner/auto-repair.sh` Z. 38–48/91–97/191–196: F10-Kommentare auf „kanonisch einziger Name“ kürzen (Code unverändert — `fleet_name_variants` ist Passthrough).
* `scripts/hetzner/bring-up-fleet.sh` Z. 101–103 Kommentar.

---

## 3. Commit-Reihenfolge

Empfehlung (atomarer Revert, entspricht Task-Vorschlag):
1. `refactor: samplemonk-Legacy-Shims entfernt (Flotte 2026-09-11 gestoppt) — Phase 1` → alle Phase-1-Dateien + Wächter + Doku in **einem** Commit ( consumer-Scripts und Quelle müssen zusammen, sonst `set -u`-Crash / rote Wächter-Tests).
2. (nur nach Vorbedingung) `refactor: Alt-Snapshot-Erkennung entfernt (Bestand verifiziert 0) — Phase 2`.
Alternative Aufteilung, falls reviewbar kleiner gewünscht: 1a Skripte+py-Test, 1b TS/Worker+vitest-Tests+Wächter, 1c Doku — Wächter bleibt in jedem Zwischenstand grün (je entferneter Eintrag ist die Datei bereits sauber).

---

## 4. Risiko- & Revert-Strategie

| # | Risiko | Bewertung | Gegenmaßnahme |
|---|---|---|---|
| R1 | **Alt-präfixte Snapshots existieren evtl. noch** (SSOT item 129: 10 Snapshots, bis zu 5 mit Alt-Bezug; ~1,06 €/Monat gesamt) | Mittel — Kostenleck: nach Phase 2 listet/putzt der Worker sie nicht mehr | Phase 2 nur nach Live-Zählung; einmalige Löschung/Anerkennung als Beleg im SSOT vermerken |
| R2 | **Nächster Wake wird langsamer**: heute bootet `findSnapshot()` von den (neuesten passenden) Alt-Snapshots (~60 s); ohne sie → Kaltstart cloud-init+Build (~5 min), bis frische kanonische Snapshots existieren | Mittel (reine Startzeit, keine Korrektheit) | In Doku Nachtrag erwähnen; erste Live-Session erzeugt per `/api/refresh-snapshots`/`lifecycle.sh stop` kanonische Snapshots |
| R3 | Verbraucher-Skripte crashen mit „unbound variable“ (`set -u`), wenn fleet-names.sh ohne sie geändert wird | Hoch bei Teil-Commit — deshalb Phase 1 als EIN Commit | Section 2 listet jede Pflichtänderung; `bash -n` + Trockenläufe (`--print-config`) nach Umsetzung |
| R4 | Watchdog/`auto-repair.sh` findet auf einem Knoten, der aus einem ALTEN Snapshot bootet, Alt-benannte Container (`samplemonk`/`samplemonk-caddy`, restart:unless-stopped) nicht mehr | Niedrig (0 Knoten; Restore erzeugt kanonische Namen; Alt-Container nur in Snapshot-Inhalt vom 18.09.) | In OPS_RUNBOOK-Beleg vermerken; falls je reanimiert: Einmal-`docker compose stop` wie portal-worker-Kommentar Z. 47–55 |
| R5 | Wächter-Fehlalarm: vergessener ALLOWED-Eintrag (stale-check, namingConventions Z. 103–109) oder neues Trefferfile | Sicherungsnetz statt Risiko — Test schlägt fehl und nennt die Datei | Nachher-Bild (§5) als Checkliste nehmen |
| R6 | Migrations-/Cleanup-Wissen geht verloren (Skripte gelöscht) | Niedrig | Belegketten bleiben: OPS_RUNBOOK 1259–1277, audit-infra-hetzner 316/468/504, HETZNER_DEPLOY-Nachtrag, git-History; Revert holt Code zurück |
| R7 | NTFS-Repo: Mode-Rauschen/chmod-Fallen | Prozessrisiko | `core.fileMode=false` UNVERÄNDERT lassen; keine chmod/chown; Revert via `git revert`, nicht stash (Skill-Hinweis) |

**Revert:** Phase 1 ist ein Commit → `git revert --no-edit <sha>` stellt alle Skripte/Tests/Wächter/Doku atomar wieder her. Phase 2 separat revertierbar. Kein Datenverlust möglich: es werden keine Volumes/Snapshots/Server angefasst — rein Repo-Text.

---

## 5. Statische Verifikation

### 5.1 Jetzt gemessen (Basis d1fb16c, alle grün)
```bash
for f in scripts/hetzner/fleet-names.sh scripts/hetzner/lifecycle.sh scripts/hetzner/fleet-status.sh \
         scripts/hetzner/fleet-deploy-live.sh scripts/hetzner/auto-repair.sh scripts/hetzner/delete-fleet.sh \
         scripts/hetzner/bring-up-fleet.sh scripts/hetzner/migrate-project-name.sh deploy.sh; do bash -n "$f" && echo "OK $f"; done
node --check services/portal-worker/src/index.js
python3 -m py_compile tests/test_hetzner_scripts.py scripts/hetzner/cleanup-legacy-firewalls.py
```
→ 9× bash -n OK, node --check OK, py_compile OK (Protokoll des Analyse-Laufs).

### 5.2 Nachher-Bild des Wächters (Simulation)
```bash
git grep -l -I -i -E 'sample[-_]?monk' | sort
# NACH Phase 1+2 erwartet (10 Dateien, inkl. dieses Proposals):
# docs/FIXPLAN_2026-09-20_externer_apptest.md
# docs/HETZNER_DEPLOY.md
# docs/OPS_RUNBOOK.md
# docs/PROPOSAL_legacy-shim-removal.md
# docs/audit-infra-ARCHITEKTUR.md
# docs/audit-infra-hetzner.md
# MASTERTODOENDE.json
# services/audiomonastry-ai-runtime/Dockerfile.manifest
# tests/namingConventions.test.ts
# visualsUMSETZUNGSPLAN.md
# Simulation gegen den IST-Stand: IST-Liste (15 Dateien) minus {fleet-names.sh,
# fleetWiring.ts, index.js, fleetWiring.test.ts, portalWorkerSnapshots.test.ts,
# test_hetzner_scripts.py} plus PROPOSAL = exakt obige 10.  (gemessen 2026-09-29)
```
Wächter-Semantik geprüft: Test 1 (nur begründete Treffer) und Test 2 (keine veralteten Einträge, Z. 103–109) sind genau dann grün, wenn ALLOWED ↔ Nachher-Bild deckungsgleich sind — deshalb PROPOSAL-Eintrag ergänzen und Phase-Zuordnung der Einträge 36/41 einhalten.

### 5.3 Nach Umsetzung (durch Umsetzer, nicht hier)
```bash
bash -n <jede angefasste .sh>
node --check services/portal-worker/src/index.js
python3 -m py_compile tests/test_hetzner_scripts.py
node node_modules/vitest/vitest.mjs run tests/namingConventions.test.ts tests/fleetWiring.test.ts \
  tests/portalWorkerSnapshots.test.ts tests/portalWorkerR2EnvParity.test.ts
python3 -m pytest tests/test_hetzner_scripts.py -k "NamespaceParitaet or Watchdog or FirewallWerkzeuge or DeleteFleet" -x
# kein npm/vitest-Vollauf, solange die Hauptsuite parallel läuft (Vorgabe)
```
tsc/eslint: keine Typ-/Lint-Fläche verändert (`fleetNodeAddress`-Signatur bleibt, nur Rumpf); `index.js` ist plain JS (node --check genügt).

---

## 6. Offene Fragen an den Betreiber
1. Live-Zählung Alt-Snapshots (§5.2-Kommando) — Freigabe für Phase 2 erst nach Bestand=0 oder bewusstem Verzicht.
2. `migrate-project-name.sh` + `cleanup-legacy-firewalls.py`: Löschung bestätigt? (Empfehlung: ja; Beleg bleibt in git-History/Audits. Alternative: ein Release-Intervall als Archiv belassen — dann MÜSSEN `LEGACY_COMPOSE_PROJECT`/`LEGACY_FLEET_PREFIX` in fleet-names.sh bleiben, was der Ausmusterung widerspricht.)
3. `Dockerfile.manifest`-Alt-Basis-Image-ARG (Z. 32): eigener Folgeauftrag außerhalb dieses Scopes?
4. Soll der Wächter-Eintrag für dieses PROPOSAL nach erfolgreicher Umsetzung + ein paar Wochen wieder entfallen (dann ist die Datei selbst Kandidat fürs Archiv)?
