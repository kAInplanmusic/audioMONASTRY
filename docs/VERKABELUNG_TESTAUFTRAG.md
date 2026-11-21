# Testauftrag: Verkabelung der App (Bedienelemente, Plugins, KI-Kette)

Stand 2026-11-19, Basis `main`. Auftragnehmer: Betreiber-Agent mit Shell, Docker und Hetzner-Zugang.
Bezug: `VerkabelungsToDo.md` (Befundliste), `docs/FLEET_INTERFACES_AND_GATES.md` (Schnittstellen I1–I11), `docs/VERIFY_MATRIX.md` (Gates).

## 0. Ziel und Regeln

**Ziel:** Belegen, welche Verbindungen der App funktionieren und welche nicht – von jedem Regler/Knopf bis zum KI-Modell auf dem richtigen Pod – ohne GPU-Kosten, mit Ersatz-Pods. Ergebnis ist ein Testbericht (Abschnitt 6), der jeden Punkt aus `VerkabelungsToDo.md` als *bestätigt*, *widerlegt* oder *nicht geprüft* markiert.

**Regeln (verbindlich):**
1. **Keine neuen Schlüssel** anfordern oder erzeugen (außer dem lokalen Wegwerf-Token der Ersatz-Pods). Schlüsseltausch macht der Betreiber erst, wenn das System vollständig steht. Keine Schlüsselwerte in Logs, Berichte oder Commits.
2. **Keine DNS-Änderungen.** Projekt-Armageddon-Ressourcen bei Hetzner (Snapshot `projectarmageddon`, IP `pa-spiel-ipv4`) **nie anfassen**.
3. **Ersatz ist Ersatz:** Ein grüner Lauf gegen Ersatz-Pods belegt die *Verdrahtung* (richtige Rolle, richtiges Modell, richtige Route, Auth, TLS), **nicht** Modellqualität, Laufzeit oder echte Audioausgabe. Im Bericht nie als „live“ oder „GPU“ bezeichnen.
4. **Nicht bis grün wiederholen.** Jeder Lauf wird mit Ergebnis protokolliert; ein Wiederholungslauf nur nach einer echten Änderung (Code/Umgebung) und getrennt dokumentiert.
5. **Code-Fixes** sind nicht Teil dieses Auftrags. Gefundene Fehler kommen in den Bericht und als Häkchen-Kommentar in `VerkabelungsToDo.md`.
6. **Kosten:** Phasen A–E kosten nichts außer optional einem Hetzner cx23 (ca. 0,01 €/h). Phase G (echte Vast-Flotte) nur mit ausdrücklicher Freigabe des Betreibers.
7. **Aufräumen** ist Teil jedes Laufs (Abschnitt 7).

## 1. Umgebung

| Was | Version / Wert | Prüfen mit |
| --- | --- | --- |
| Betriebssystem | Linux x86_64 (Ubuntu 24.04 empfohlen) | `uname -m` |
| Node.js | 22.x (CI-Stand) | `node -v` |
| Python | ≥ 3.11 | `python3 -V` |
| openssl | beliebig aktuell (für Ersatz-Zertifikate mit IP-SAN) | `openssl version` |
| Docker + Compose v2 | für Phase D | `docker compose version` |
| Playwright-Chromium | für Phase E (`npx playwright install chromium`, falls nicht vorhanden) | `npx playwright --version` |
| Freie Ports | 18001–18008 (Ersatz-Pods), 18080 (App) | `ss -ltn` |

Vorbereitung (einmalig): `git clone` des Repos, `git checkout main && git pull`, `npm ci`. Die Sim-Werkzeuge brauchen nur die Python-Standardbibliothek; für `npm run test:python` die Pakete laut `docs/VERIFY_MATRIX.md`.

### 1.1 Option Hetzner (wenn lokal kein Linux/Docker)
- Server **cx23**, Image **ubuntu-24.04**, Standort beliebig, Name `am-wiring-test-<datum>`, Label `purpose=wiring-test`.
- Cloud-Init: Docker + Node 22 + Git installieren, Repo klonen (öffentliche Pakete reichen; das Repo braucht Lesezugriff).
- Kein Snapshot nötig. Der App-Snapshot `457927664` ist für den echten Betrieb da und wird hier **nicht** verwendet (er würde echte Pod-Werte erwarten).
- Nach dem Test Server löschen (Abschnitt 7) – auch bei Abbruch.

## 2. Werkzeuge im Repo

| Werkzeug | Zweck |
| --- | --- |
| `scripts/sim/fake_pod.py` | Ersatz-Pod mit **demselben Vertrag** wie der echte Pod: HTTPS, `Authorization: Bearer AI_POD_TOKEN`, `/health`, `/ready`, `/models`, `POST /runsync`, `POST /run`, `GET /status/{id}`, `POST /cancel/{id}`. Kennt die Modelle seiner Rolle aus `deploy/gpu/pod-fleet.json`; ein Modell, das nicht auf der Rolle liegt, wird wie beim echten Pod mit Fehler abgelehnt. Protokolliert jeden Auftrag in `requests.jsonl` (Rolle, Task, Modell, Feldnamen der Eingabe – keine Inhalte). |
| `scripts/sim/run_fake_fleet.sh [DIR]` | Startet die 8 Ersatz-Pods (brain, ears, voice, music, studio, audio-brain, song, vis) auf 18001–18008, erzeugt Zertifikate + `ca.pem` und schreibt die App-Umgebung `DIR/sim-runtime.env`. |
| `scripts/sim/app-call-check.ts [OUT]` | Ruft über den **echten App-Code** (`VastProvider` + `podRouting`) jede GPU-Rolle (Teil A: `warmup`) und jedes Modell aus `MODEL_POD` mit der Rolle/Aufgabe auf, mit der die App es nutzt (Teil B, 24 Fälle). |
| `scripts/sim/evaluate_wiring.py LOG` | Wertet `requests.jsonl` (+ `--app-calls`) gegen die Soll-Verdrahtung (`MODEL_POD` in `podRouting.ts`, `pod-fleet.json`) aus; `--md`/`--json` Bericht, Exit 0 = bestanden. |
| `scripts/audit-wiring/*` | Statische Prüfungen (Routen, Events, KI-Aufgaben, Bedienelemente, Regler ohne Wirkung), siehe `VerkabelungsToDo.md` Abschnitt 6. |

**Stellschrauben von `run_fake_fleet.sh` (Umgebungsvariablen):**

| Variable | Standard | Wirkung |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Adresse der Pods (für Docker ohne Host-Netz: Bridge-IP, z. B. `172.17.0.1`) |
| `READY_AFTER` | `0` | `/ready` meldet 503 für N Sekunden (Kaltstart simulieren) |
| `READY_TIMEOUT_MS` | `30000` | wie lange die App auf `/ready` wartet (`AI_POD_READY_TIMEOUT_MS`) |
| `LATENCY` | `0` | Sekunden Verzögerung je Auftrag |
| `FAIL_ROLE` + `FAIL_TASK` | – | diese Rolle beantwortet diesen Task mit Fehler |
| `SKIP_ROLE` | – | dieser Pod wird nicht gestartet und hat keine URL |
| `EUR_PER_HOUR` | `0.5` | Preis je Pod für das App-Budget (`VAST_POD_EUR_PER_HOUR_<ROLLE>`) |
| `NO_PRICE` | `0` | `1` = Preise weglassen → die App **muss** jeden Start blocken (fail-closed) |
| `AI_POD_TOKEN` | zufällig | Bearer-Token der Ersatz-Pods (nur lokal, wird verworfen) |

**Von der App gelesene Variablen** (stehen in `sim-runtime.env`): `AI_GPU_PROVIDER=vast`, `AI_FLEET_MODE=pods`, `AI_POD_TOKEN`, `NODE_EXTRA_CA_CERTS`, `VAST_POD_URL_<ROLLE>` (`-`→`_`, nur `https://host:port`), `VAST_POD_EUR_PER_HOUR_<ROLLE>`, `AI_POD_READY_TIMEOUT_MS`, `AI_POD_READY_POLL_MS`. Für den Server zusätzlich: `PORT`, und entweder `AUDIOMONASTRY_DEV_NO_AUTH=1` (nur lokal, `NODE_ENV≠production`) oder `STUDIO_ACCESS_TOKEN` (≥ 32 Zeichen, Header `x-studio-token`).

### Lokalen GPU-Simulator im Release-Test nutzen

Die Simulation läuft in `scripts/sim/fake_pod.py` und `scripts/sim/fake_agent.py`. Der Pod-Katalog kommt aus dem aktuellen Repo. TTS, Song, Sound, Mastering und Upsampling liefern kurze synthetische WAVs. Beim BS-RoFormer gibt es fünf App-Ausgaben für Mixer und Library. Mit `includeModelStems` kommen sechs unterscheidbare Modellspuren in `modelStemAudio` hinzu. Der Fake Agent kann aus einem expliziten Tempo-Prompt und dem übergebenen Kommandokatalog einen DAW-Vorschlag erzeugen. Die App ist weiterhin für Autorisierung und Ausführung zuständig.

Der integrierte Testserver unterstützt Inline-Audio und weist angeforderte Upload-URLs ab. Visual-Rendering hat eine eigene Release-Prüfung. Die Simulation belegt das Routing und den Umgang mit den Ausgaben. Modellqualität, echte GPU-Readiness und VRAM bleiben Live-Prüfungen.

Vertragstests und Audio-Smoke bis zur Library-Schnittstelle aus dem Repo-Stamm starten. Der Smoke verwendet ausschließlich lokale Pod-URLs, die echte Stem-Verarbeitung der App und Testablagen im Speicher.

```bash
python3 -m unittest discover -s scripts/sim -p 'test_*.py'
env -i PATH="$PATH" bash <<'BASH'
set -euo pipefail
sim_dir=$(mktemp -d)
trap 'if [ -s "$sim_dir/pids" ]; then xargs -r kill < "$sim_dir/pids"; fi; rm -rf "$sim_dir"' EXIT
bash scripts/sim/run_fake_fleet.sh "$sim_dir"
set -a
. "$sim_dir/sim-runtime.env"
VAST_POLL_INITIAL_MS=25
set +a
node --import tsx scripts/sim/check-fake-audio.ts
BASH
```

## 3. Phasen und Ausführung

Alle Befehle im Repo-Wurzelverzeichnis. Arbeitsordner `sim/` (in `.gitignore`).

### Phase A – Statische Prüfung (ohne Netz, ca. 10 min)
```bash
npm run typecheck
npm run lint            # bekannt rot: 41 Warnungen in 15 Dateien (TODO P2)
npm test
npm run test:python
python3 scripts/audit-wiring/routes.py; python3 scripts/audit-wiring/events.py
python3 scripts/audit-wiring/ai.py;     python3 scripts/audit-wiring/stateonly.py
node scripts/audit-wiring/ui-controls.cjs
```
**Wichtig:** Für `test` und `test:python` vorher auf `main` die Liste der schon roten Tests festhalten (gleicher Rechner, gleicher Stand) und im Bericht nur **neue** Abweichungen als Befund führen. Die Ausgaben der Audit-Skripte mit `VerkabelungsToDo.md` vergleichen: jeder dort genannte Punkt muss wieder auftauchen, jeder neue Treffer wird einzeln am Code nachgeprüft.

### Phase B – KI-Kette gegen Ersatz-Flotte (ohne GPU, ca. 2 min je Variante)
```bash
bash scripts/sim/run_fake_fleet.sh sim
set -a; . sim/sim-runtime.env; set +a
npx tsx scripts/sim/app-call-check.ts sim/app-calls.jsonl
python3 scripts/sim/evaluate_wiring.py sim/requests.jsonl --app-calls sim/app-calls.jsonl \
  --expect-models all --md sim/B0-report.md --json sim/B0-report.json
kill $(cat sim/pids)
```
Danach jede Variante aus der Matrix in einem **frischen** Ordner (`sim/B1`, `sim/B2`, …), z. B. `NO_PRICE=1 READY_TIMEOUT_MS=3000 bash scripts/sim/run_fake_fleet.sh sim/B1`.

| ID | Variante (Umgebung) | Erwartetes Ergebnis | Referenzlauf 2026-11-19 (Sandbox) |
| --- | --- | --- | --- |
| B0 | Standard | `passed: true`; 24 Modellaufträge, 0 Fehlleitungen, alle 21 `MODEL_POD`-Modelle angesprochen; `acestep-v15-shared` einmal auf voice, einmal auf music | **bestanden** (29 Aufträge inkl. 5 warmup) |
| B1 | `NO_PRICE=1 READY_TIMEOUT_MS=3000` | **muss rot sein**: jeder Auftrag blockiert mit „… kosten Infinity €/h … AI-Budget“; kein einziger Auftrag erreicht einen Pod | rot wie erwartet (29 blockiert) |
| B2 | `SKIP_ROLE=studio READY_TIMEOUT_MS=3000` | rot: genau die 6 studio-Modelle mit „Pod studio fehlt“, alle anderen grün | rot wie erwartet (6) |
| B3 | `FAIL_ROLE=ears FAIL_TASK=audio.analyze` | rot: genau beat-this, songformer, dsp-analysis mit Fehler; App reicht den Fehler durch, kein Absturz | rot wie erwartet (3) |
| B4 | `READY_AFTER=10` | grün, aber erste Aufträge je Rolle warten ≈ 10 s (App pollt `/ready`); Wartezeit im Bericht notieren | nicht gelaufen |
| B5 | `READY_AFTER=60 READY_TIMEOUT_MS=5000` | rot: App meldet Readiness-Frist im Log und übernimmt den Fehler der Job-Antwort. Der lokale Pod meldet `MODEL_UNAVAILABLE` und liefert kein Audio. | nicht gelaufen |
| B6 | `LATENCY=40` | Aufträge der `LONG_RUNNING_TASKS` (song, stem.separate, audio.master …) laufen über `/run` + `/status` und kommen an; kurze Tasks über `/runsync`; Zeitverhalten notieren | nicht gelaufen |
| B7 | falsches Token: nach dem Start `AI_POD_TOKEN` in `sim-runtime.env` ändern | rot: alle Aufträge 401; App meldet Auth-Fehler, **kein** Schlüssel im Log | nicht gelaufen |

### Phase C – App-Server (HTTP) gegen Ersatz-Flotte (ca. 10 min)
```bash
bash scripts/sim/run_fake_fleet.sh sim/C
set -a; . sim/C/sim-runtime.env; set +a
PORT=18080 AUDIOMONASTRY_DEV_NO_AUTH=1 npx tsx server.ts > sim/C/server.log 2>&1 &
curl -s http://127.0.0.1:18080/api/health
curl -s http://127.0.0.1:18080/api/ai/fleet/status
curl -s -X POST -H 'content-type: application/json' \
  -d '{"prompt":"Sag hallo","messages":[{"role":"user","content":"Sag hallo"}]}' \
  http://127.0.0.1:18080/api/ai/complete
```
Erwartet: Gesundheit 200; `fleet/status` mit `aiEnabled:true`; `/api/ai/complete` liefert `{"provider":"vast-local","text":"simulated llm/qwen38-27b-fp8",…}` und in `sim/C/requests.jsonl` steht eine Zeile `brain / llm / qwen38-27b-fp8`. **Referenzlauf 2026-11-19: genau so bestanden.**
Weiter mit den übrigen KI-Routen (`/api/ai/generate`, `/api/ai/compose`, `/api/ai/describe`, `/api/ai/drop-audio`, `/api/ai/executor`, `/api/ai/jobs`, `/api/ai/agent/runs`, Stem-/Song-/Voice-Routen; Liste: `grep -o "app\.\(get\|post\)('/api/ai[^']*" -r server.ts server`). Für jede Route: Anfrage, HTTP-Status, ob und welche Zeile im Ersatz-Pod-Protokoll entsteht, Erwartung laut Code. Eine Route, die einen Pod erreichen müsste und es nicht tut, ist ein Befund.
Zusätzlich prüfen: `POST /api/ai/fleet/wake` und `/sleep` (ohne Vast-Schlüssel muss Start/Stopp sauber mit Meldung scheitern, I11), `/api/ai/mcp/tools` (TODO P0: listet entfernte FLUX/Wan/LTX-Werkzeuge – bestätigen oder widerlegen).

### Phase D – Docker (Produktions-Image, ca. 20 min inkl. Build)
Ziel: Dasselbe wie Phase C, aber im Container mit `NODE_ENV=production` und echtem Zugangsschutz.
```bash
docker build -t audiomonastry:wiring .
bash scripts/sim/run_fake_fleet.sh sim/D
TOKEN=$(python3 -c 'import secrets;print(secrets.token_urlsafe(40))')
docker run -d --name am-wiring --network host --env-file sim/D/sim-runtime.env \
  -e NODE_EXTRA_CA_CERTS=/sim/ca.pem -e PORT=18080 -e NODE_ENV=production -e STUDIO_ACCESS_TOKEN="$TOKEN" \
  -v "$PWD/sim/D:/sim:ro" audiomonastry:wiring
curl -s -H "x-studio-token: $TOKEN" http://127.0.0.1:18080/api/ai/fleet/status
```
Erwartet: ohne Header 401 (außer `/api/health`), mit Header wie Phase C. **Nicht in der Sandbox ausgeführt** – erster Lauf ist Neuland; Abweichungen (Image-Startbefehl, Pfade) als Befund festhalten, nicht improvisiert wegpatchen.
Variante D2 ohne Host-Netz: `HOST=172.17.0.1 bash scripts/sim/run_fake_fleet.sh sim/D2` (Zertifikat-SAN folgt `HOST`) und `docker run` mit `-p 18080:18080` statt `--network host`.

### Phase E – Browser, 4 Nutzer, Bedienelemente (ca. 30–60 min)
App wie in Phase C laufen lassen (Ersatz-Flotte aktiv), dann:
```bash
E2E_BASE_URL=http://127.0.0.1:18080 npx playwright test tests/e2e/collab.spec.ts tests/e2e/pluginPersistence.spec.ts \
  tests/e2e/operatorModes.spec.ts tests/e2e/pluginCloseSync.spec.ts tests/e2e/r17-takeover.spec.ts \
  tests/e2e/noDeviceStorage.spec.ts tests/e2e/monitorCue.spec.ts tests/e2e/aiMonkManual.spec.ts --trace off
```
Danach **gezielte Handprüfung** der TODO-Punkte (Playwright-Skript oder vier Browserfenster). Je Punkt: Schritt, erwartete Wirkung, beobachtete Wirkung, Beleg (Screenshot/Log/Netzwerkzeile).

| TODO | Prüfschritt | Wenn der Befund stimmt, sieht man … |
| --- | --- | --- |
| P0 DSP-Limiter | dspMONK frisch öffnen, Limiter-Ceiling ablesen; Testton 0 dBFS anlegen, Main-Pegel messen | Ceiling-Wert +0,98 dB statt −1 dB; Ausgang überschreitet 0 dBFS |
| P0 Drop-Preset löschen | dropMONK → Preset speichern → Papierkorb | Preset bleibt, keine Netzwerkanfrage |
| P0 MCP-Werkzeuge | `GET /api/ai/mcp/tools` | `image.generate`/`video_*` in der Liste |
| P1 Mischpult Filter/Send/Makros/FX LOCK | Regler bewegen, Main-Pegel/Spektrum vorher/nachher | Zustand ändert sich, Klang nicht |
| P1 „Main Out“-Knopf | anklicken | keine Wirkung |
| P1 Pad-Regler Deck | drehen | keine Wirkung |
| P1 controlBus-Events (9) | jeweiligen Sprach-/Agentenbefehl auslösen (Tabelle 2.3) | Event im Bus, keine sichtbare Wirkung |
| P1 Socket-Meldungen (6) | als Nutzer 2 fremdes Plugin ändern, zweites Main-Out-Gerät, Session-Reset | Server verweigert, UI zeigt nichts |
| P1 drop/biblio Persistenz | Nutzer 1 stellt ein, gibt ab; Nutzer 2 übernimmt | Einstellungen weg (bei den anderen 14 Plugins vorhanden) |
| Sperre (B2B) | Nutzer 1 hält Plugin; Nutzer 2–4 versuchen Änderung | gesperrt/grau bei 2–4, keine Zustandsänderung |
| Spiegelung | beliebige Änderung bei Nutzer 1 | in < 1 s identisch bei 2–4 |
| Keine Gerätespeicherung | nach dem Lauf `localStorage`/`IndexedDB` aller 4 Kontexte | leer (außer erlaubten Ausnahmen laut AGENTS.md) |

### Phase F – Hetzner (gleiches wie B–E auf einem frischen Server)
Nur nötig, wenn lokal kein Linux/Docker vorhanden ist oder ein zweiter, unabhängiger Lauf gewünscht ist. Server laut 1.1 anlegen, Phasen A–E dort ausführen, Ordner `sim/` als Archiv herunterladen (`tar czf`), Server löschen. In den Bericht: Server-Typ, Standort, Laufzeit, Kosten laut Hetzner-Rechnungsvorschau.

### Phase G – echte Flotte (nur mit Freigabe, kostet GPU-Geld)
Voraussetzung: Vast-Guthaben ≥ 15 €, Freigabe des Betreibers. `KEEP=1 bash scripts/fleet-up-measure.sh` auf einem Rechner mit freiem Netz (nicht Cloud-Sandbox). Danach mit der von `scripts/finalize-runtime-from-probe.py` erzeugten Umgebung `npx tsx scripts/sim/app-call-check.ts sim/G/app-calls.jsonl` und `evaluate_wiring.py` **ohne** `requests.jsonl` (echte Pods protokollieren nicht in diese Datei; Auswertung nur über `--app-calls`). Danach `python3 scripts/vast-pods.py down --yes`. Jeder Auftrag belegt dort GPU-Zeit; Teil B ist 24 Aufträge.

## 4. Was besonders wichtig ist
1. **Richtiger Pod je Modell** (Phase B0): Fehlleitung = Auftrag läuft auf Instanz ohne Modell → in Produktion „model not resident on this pod“. Null Toleranz.
2. **Fail-closed** (B1, B7, D ohne Token): ohne Preis, ohne Token, ohne Zugangsschutz darf nichts starten oder antworten.
3. **Keine Geheimnisse in Logs:** `grep -rE "Bearer [A-Za-z0-9_-]{20,}|AI_POD_TOKEN=" sim/*/server.log sim/*/fake-pods.log` muss leer sein.
4. **Sperre und Spiegelung** (Phase E) – Kern der Architektur (AGENTS.md 1.2).
5. **Latenz:** Kein Testschritt darf die Audio-Pfade verlangsamen; Phase B/C prüfen nur die KI-Strecke. Keine Änderung an RT-/Audio-Gates.

## 5. Auswertung – Kriterien
| Bereich | bestanden, wenn |
| --- | --- |
| A | Typecheck grün; keine **neuen** roten Tests ggü. Basisliste; Audit-Skripte zeigen mindestens alle TODO-Punkte, neue Treffer einzeln bewertet |
| B | B0 `passed:true`; B1–B3, B5, B7 rot **genau mit der erwarteten Ursache** (eine rote Variante mit anderer Ursache ist ein Befund); B4/B6 grün mit notierten Zeiten |
| C | jede KI-Route: erwarteter Status und erwarteter Pod-Treffer laut Tabelle |
| D | wie C, plus 401 ohne Token |
| E | e2e-Specs grün (Abweichungen gegen den Stand auf `main` vergleichen); jeder TODO-Punkt mit Ergebnis *bestätigt/widerlegt* und Beleg |

`evaluate_wiring.py` Felder: `misrouted` (falscher Pod), `unknownModels` (Modell nicht in `MODEL_POD`), `expectedButNotHit`, `appCallsFailed` (App-Aufruf gescheitert), `preloadNotInFleet` (**nur Warnung**: Vorladeliste `GPU_ROLES.preload` nennt Modelle, die kein Pod hat; der echte Pod ignoriert die Liste bei `warmup`, `pod_jobs.py:103`).

## 6. Bericht (Abgabe)
Datei `docs/VERKABELUNG_TESTBERICHT_<JJJJ-MM-TT>.md` + Archiv `sim/` (nicht committen, nur auf Anfrage weitergeben):
```
# Verkabelungstest <Datum>
Basis: main @ <commit>; Rechner: <lokal|Hetzner cx23 …>; Node/Python/Docker-Versionen
## Zusammenfassung   (je Phase: bestanden / nicht bestanden / nicht geprüft, eine Zeile Grund)
## Phase A … G       (Befehl, Exit-Code, Kernausgabe, Abweichung ggü. Basis)
## TODO-Abgleich     | TODO-Punkt | Ergebnis (bestätigt/widerlegt/nicht geprüft) | Beleg |
## Neue Befunde      | Nr | Datei:Zeile | Beobachtung | Schwere P0/P1/P2 |
## Kosten und Aufräumen  (Server/Instanzen angelegt und gelöscht, Zeitpunkt)
## Grenzen           (was Ersatz-Pods nicht beweisen)
```
In `VerkabelungsToDo.md` je Punkt nur einen Hinweis „Test <Datum>: bestätigt/widerlegt (Bericht §…)“ ergänzen; Häkchen setzt erst, wer den Fehler behebt.

## 7. Aufräumen (immer, auch bei Abbruch)
```bash
kill $(cat sim/*/pids sim/pids 2>/dev/null) 2>/dev/null; pkill -f "tsx server.ts"; docker rm -f am-wiring 2>/dev/null
```
Hetzner: Server `am-wiring-test-*` löschen und prüfen, dass **nur** Ressourcen mit Label `purpose=wiring-test` betroffen sind; Snapshot `457927664` und alle Armageddon-Ressourcen bleiben. Phase G: `python3 scripts/vast-pods.py down --yes` und `status` = 0 Instanzen.

## 8. Bekannte Grenzen
- Ersatz-Pods antworten mit Platzhaltern (Stille-WAV, Text „simulated …“); ob Modelle *richtig* klingen, prüft nur Phase G bzw. ein Hörtest.
- `vis`-Pod ist von der App nicht angesprochen (I10) – Phase B/C zeigen ihn ohne Aufträge; das ist ein bekannter TODO-Punkt, kein Testfehler.
- `GPU_ROLE_LIST` enthält noch die entfernten Rollen `imageHq`, `videoReal`, `videoAbstract`; ihr `warmup` endet mit „pod not ready/configured“ und zählt nicht als Fehler (TODO P0 MCP-Werkzeuge).
