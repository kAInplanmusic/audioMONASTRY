# FIXPLAN — Externer App-Test audioMONASTRY (Hetzner), Stand 2026-09-20

Quelle: externer App-Test gegen die Hetzner-Flotte vom 2026-09-20 (app-1 142.132.229.71,
Deploystand 2026-09-18, Repo-HEAD ae5e749). Alle Befunde sind real gemessen; die
Rohdaten liegen unter `/home/patrick/e2e-audiomonastry/` und
`/home/patrick/ext-audit-2026-09-20.md`.

Rahmen: **kein RunPod, keine AI-Rollen** — es geht nur um die Hetzner-Kette
(app/sfu/master/edge + Portal + Cloud-Speicher).

Arbeitsweise: ein Fix pro Zweig (`hermes/fix-F<n>`), Worktree, kein Push.
Merge erst nach `npm run typecheck` + betroffenem Test + Review durch den Auftraggeber.

---

## Stand 2026-09-20 nach dem Fix-Schwung (F1–F10 umgesetzt und gemergt)

Alle zehn Fixes sind code-seitig umgesetzt, reviewt, gemergt und durch den
Gate-Lauf (`npm run verify`, 272 Testdateien / 1972 Tests, 0 kritische
Audit-Findings) sowie `npm run build` gedeckt. Kein Fix ist vollständig
„abgeschlossen“: jeder hat einen Rest, der **live** auf der Flotte bzw. beim
Betreiber (Token/Werte) nachzuweisen ist. Genau das steht in der letzten Spalte —
und in `MASTERTODOENDE.json` als `PROD-P0-F1` … `PROD-P3-F10` mit `live_open`.

> Historischer Abschnitt archiviert: `EVIDENCE_REGISTRY.json` →
> `R2-A2-HISTORY-DOMAIN-06`, Originalzeilen 25–37.
> Der unveränderte Wortlaut ist dort nachlesbar; keine aktuelle Dienstzusage.

Zusätzliche Blocker auf `main`, die beim Nachfahren gefunden und behoben wurden
(Details im jeweiligen Commit):

* `fix(lint)`: `eslint .` brach mit 5915 Parsing-Fehlern ab, sobald Agenten-Worktrees
  unter `.worktrees/` lagen (mehrdeutiges `tsconfigRootDir`) — der gesamte
  verify-Lauf war damit unbrauchbar.
* `fix(lint)`: F4 brachte einen ungenutzten Helfer im Portal-Worker mit (Lint-Tor).
* `fix(test)`: Hetzner-Skripttests waren rot, weil `fleet-preflight.sh` die echte
  `.env.deploy` sourct; jetzt `FLEET_ENV_FILE` (Default `.env.deploy`, `none` = nichts).
* `fix(transport)`: F6 importierte `resolveSfuSignalingTarget` ungenutzt (Lint-Tor).

---

## Live-Beweise 2026-09-21: F1 und F6 sind live abgeschlossen (gemessen)

> Historischer Abschnitt archiviert: `EVIDENCE_REGISTRY.json` →
> `R2-A2-HISTORY-DOMAIN-06`, Originalzeilen 53–55.
> Der unveränderte Wortlaut ist dort nachlesbar; keine aktuelle Dienstzusage.

> Historischer Abschnitt archiviert: `EVIDENCE_REGISTRY.json` →
> `R2-A2-HISTORY-DOMAIN-06`, Originalzeilen 56–65.
> Der unveränderte Wortlaut ist dort nachlesbar; keine aktuelle Dienstzusage.

Werkzeuge, die dafuer entstanden sind (beide mit Trockenlauf, Token wird nie ausgegeben):

* `scripts/hetzner/cf-dns-ensure.py [--apply]` — setzt/repariert beide A-Records
  (App + SFU) auf **A, DNS-only**; erkennt Drift (falscher Server, `proxied=true`)
  und ist beim zweiten Lauf idempotent.
* `scripts/hetzner/fleet-preflight.sh dns` prueft jetzt **beide** Records und nennt
  bei jedem Befund den automatischen Weg (`cf-dns-ensure.py`).

Vertrag, der dabei scharf geworden ist: der **Origin-Record darf nicht durch den
Cloudflare-Proxy laufen** (der Worker holt ihn mit dem Origin-Zertifikat direkt),
und **WebRTC braucht zwingend einen oeffentlich vertrauenswuerdigen Zertifikatspfad**
— auf sfu-1 daher Let's Encrypt ueber HTTP-01 (der Record ist DNS-only, Port 80 offen)
statt eines Origin-CA-Zertifikats (das waere nur fuer Cloudflares Edge gueltig und
ein Browser wuerde es ablehnen).

**Rest (Betreiber, nur noch Werte):** die fuenf Token-Fundstellen in `.env.deploy` /
`.env.portal` sind weiterhin die ALTEN (diagnose: `1000 Invalid API Token`) und das
Worker-Secret `CLOUDFLARE_API_TOKEN` muss im Portal-Worker aktualisiert werden
(`wrangler secret put`). Der Betrieb haengt nicht daran — die Records stehen jetzt —,
aber `fleet-preflight.sh dns` sourct `.env.deploy` und wuerde den toten Wert melden,
und der Worker-DNS-Sync beim Wake braucht den gueltigen Token.

---

## Live-Beweise 2026-09-20 (gemessen, nicht behauptet)

Nach dem Deploy von `main`-Commit `37c5719` auf app-1 (`deploy.sh` mit Origin-Zertifikat
aus `.env.portal`). Alle Abfragen über den Produktionspfad (Caddy, echtes SNI,
`--resolve`), der Studio-Token wurde nur auf dem Knoten gelesen — nie ausgegeben:

| Fix | Live-Beweis |
| --- | --- |
| F2 | `/api/cloud/health` → `r2.state=degraded`, `problem=signature-mismatch`, `ok=false`, mit Begründung + Bucket/Endpoint-Kürzel. Der Fehler ist jetzt ein Betriebszustand (vorher nur 20 Log-Zeilen). Gültiges Paar fehlt weiterhin (Betreiber). |
| F3 | `POST /api/master/mix` mit **4 Spuren à 30 s** (30,7 MB JSON) → **200** und 7,68 MB gemischtes WAV zurück. Gegenprobe 5 × 120 s (153,6 MB) → **413** mit Zahlen („Gesamtgröße 146,5 MB, erlaubt 64 MB") und `limits`-Block (64 MB / 8 Spuren / 120 s). |
| F4 | `/api/health` → `{status,version,commit:"37c5719",buildTime:"2026-09-20T19:16:38Z"}` — Commit == Repo-HEAD; `grep -c clock-ping dist/server.cjs` im Container → **1**; Paritäts-Gate in `deploy.sh` ohne Abweichung. Vorher: nur `{status,version}`. |
| F5 | 60 schnelle `/api/health`-Aufrufe → **60× 200, 0× 429** (Befund war 300/300 429); `/api/online` mit Token 3× → 200; `/api/online`, `/api/session/state`, `/api/idle-signal`, `/api/metrics` ohne Token → **401** (fail-closed). |
| F7 | Header: `content-security-policy-report-only` mit abgeleitetem `connect-src` + `reporting-endpoints: default="/api/security/csp-report"`; fremder Origin („evil.example") gegen `/webrtc-signaling` → **400**. Vorher: `Access-Control-Allow-Origin: *` und CSP ohne Meldeziel. |
| F9 | `/api/idle-signal` → `verdict=active`, `shutdown=false`, `reason="aktiv: request-vor-34s"`, Header `x-idle-verdict: active` / `x-idle-shutdown: no`. Das Signal folgt echter Nutzung (vorher im Log ausnahmslos `ONLINE=0`). |
| F10 | Migration auf allen vier Knoten ausgeführt (siehe unten). |
| F6 | `/api/webrtc-config` mit Token → `iceServers: 1` mit **2 STUN-URLs**, dazu `turn.available=false` („TURN_URLS nicht gesetzt – nur STUN aktiv") und `sfu.ready=false` („SFU_SIGNALING_URL nicht gesetzt – kein SFU-Pfad für den Client"). Die Lücke wird also **laut gemeldet** statt still ein unbrauchbares ICE-Set geliefert — coturn + Firewall + `sfu.<domain>` fehlen noch live (Betreiber/DNS). |

Mit dem Deploy auf app-1 liegen die Fixes F2/F3/F4/F5/F7/F8/F9 auch als **laufender
Code** auf der Flotte; app-1 fährt Projekt `audiomonastry` mit installiertem
Cloudflare-Origin-Zertifikat (`certs/origin.crt|key`, 600, ausgestellt bis 2041).

---

## Produktionsstand je Knoten (2026-09-20, nach dem Versorgungs-Lauf)

| Knoten | Code/Image | Projekt | Dienste | Zustand |
| --- | --- | --- | --- | --- |
| app-1 (142.132.229.71) | `main` (Repo-Stand 1de9e3b, Image mit Commit-Stempel) | `audiomonastry` | audiomonastry, caddy, master-player | `/api/health` nennt den Commit; TURN-Config aktiv (`turn.available=true`, 2× `turn:` + STUN mit HMAC-Credentials); Origin-TLS-Zertifikat installiert; erreicht master-1/ai-1 (siehe unten) |
| sfu-1 (142.132.231.146) | neuer Repo-Stand + neues App-Image | `audiomonastry` | audiomonastry, caddy, **coturn** | `ENABLE_SFU=1`, `SFU_ANNOUNCED_IP` gesetzt; coturn lauscht auf 3478 (udp+tcp), Relay 49152-49201; Firewall dafür geöffnet |
| master-1 (167.233.112.182) | neues `audiomonastry-master-player:hetzner` | `audiomonastry` | master-player | `/health` 200 |
| ai-1 (178.105.66.67) | Repo-Stand + Stem-AI-Fix | (kein Compose-Stack) | ollama (entfernt 2026-10-06) (systemd), stem-ai (systemd) | `qwen2.5:7b` gepullt (4,7 GB), stem-ai `/health` 200 (war vorher tot, siehe unten); von app-1 aus erreichbar (11434/8000) |
| edge-1 (167.233.192.196) | Monitoring-Compose + Configs aktualisiert | `audiomonastry` | prometheus, grafana, alertmanager, node-exporter, cadvisor | Prometheus läuft (war in der Restart-Schleife), Grafana 200 auf `127.0.0.1:3000` |

Querverbindungen von app-1 gemessen: `master:8000` 200, `ollama (entfernt 2026-10-06):11434` 200
(`qwen2.5:7b` vorhanden), `stem-ai:8000` 200.

**Zwei weitere echte Defekte in diesem Lauf gefunden und behoben:**

1. **Stem-AI war auf ai-1 nie lauffähig**: `services/stem-ai/main.py` importiert
   `device_utils` (gemeinsames Modul in `services/backend-core/python`). Das
   Dockerfile kopiert es daneben, der venv-/systemd-Weg von
   `install-ai1.sh` nicht → `ModuleNotFoundError: No module named 'device_utils'`,
   der Dienst lief in eine Restart-Schleife und der Stem-Pfad der App zeigte auf
   einen toten Port 8000. Fix: Fallback-Import in `main.py` (eine Quelle, keine
   zweite Kopie) + Regressionstest `tests/test_stem_ai_import.py` (importiert den
   Dienst mit gestubbtem `fastapi` in einem Verzeichnis OHNE die Kopie) und als
   `npm run test:python:services` in die verify-Kette aufgenommen.
2. **TURN-Ports fehlten in der Live-Firewall**: `audiomonastry-sfu` hatte nur
   22/80/443/ICMP + RTP 40000-40099. Ohne 3478 udp/tcp und 49152-49201 udp/tcp
   kann kein Browser einen Relay aufbauen. Neu:
   `python3 scripts/hetzner/firewall-ensure-turn.py [--apply]` (idempotent,
   Trockenlauf per Default, Zahlen identisch mit `portal-worker/firewallRules`
   und `provision.py`) — angewendet, Kontrolle zeigt 10 Regeln inkl. aller vier
   TURN-Regeln. Dazu `scripts/hetzner/firewall-inventory.py` für den Ist-Stand.

**Bewusst offen (Betreiber):**

* `SCRAPE_TOKEN` fehlt in der `.env` von app-1 UND edge-1 — der App-Metrik-Job
  in Prometheus bleibt deshalb 401 (fail-closed). Ein frischer Token (z. B.
  `openssl rand -hex 32`) muss in beide Rollen-.envs; das Schreiben von Secrets
  in die Knoten-.env ist ein bestätigungspflichtiger Schritt und lief in dieser
  Sitzung nicht durch.
* Cloudflare-Token (F1) und R2-Paar (F2) — siehe unten.
* `sfu.<domain>`: für HTTPS-Signalisierung braucht es einen DNS-Record und ein
  Zertifikat auf sfu-1 (sonst blockt der Browser Mixed Content — `wire-rtc.sh`
  warnt genau davor). TURN selbst läuft schon über die IP.
* Alte Verzeichnisse `/opt/samplemonk` (ai-1) und ungenutzte Legacy-Firewalls
  (`samplemonk-test/-app/-sfu/-ai/-master/-edge`) sind noch vorhanden — die
  aktiven Firewalls heißen bereits `audiomonastry-*`.

### Selbstheilung + Sicherung (installiert, mit einem weiteren Live-Befund)

`install-auto-repair.sh` läuft jetzt auf allen vier Container-Knoten (Timer alle
2 min), `install-backup-timer.sh` auf app-1 (alle 24 h). Dabei ein **dritter
Defekt**: der Installer kopierte nur den Watchdog nach `/usr/local/bin`, nicht
die Namensquelle `fleet-names.sh`, die der Watchdog seit F10 neben sich sucht —
jeder Timer-Lauf endete mit

```
/usr/local/bin/audiomonastry-auto-repair.sh: line 46: /usr/local/bin/fleet-names.sh: No such file or directory
/usr/local/bin/audiomonastry-auto-repair.sh: line 51: FLEET_COMPOSE_PROJECT: unbound variable
```

also mit einer **stummen Nicht-Reparatur**. Fix: `auto-repair.sh` sucht die
Namensquelle an zwei Orten (neben sich, dann `FLEET_NAMES_SOURCE` = Repo-Pfad) und
bricht mit Klartext ab, wenn keine gefunden wird; der Installer kopiert
`fleet-names.sh` mit. Regressionstest fährt die installierte Kopie ohne Lib
daneben. Nachweis auf allen vier Knoten: `--print-config` nennt
„App-Container: audiomonastry" (vorher Abbruch).

Der Backup-Lauf auf app-1 erzeugt ein lokales Archiv
(`/var/backups/audiomonastry/…tar.gz`, 20 MB) und meldet **off-site übersprungen**:
`node` fehlt auf dem Knoten (Off-Site läuft über `scripts/r2-backup.mjs`) — offen
bleibt also der Off-Site-Backup-Pfad (node auf dem Knoten + gültige R2-Werte).

**Nicht installiert (bewusst):** der Idle-Shutdown-Timer. Er würde die Knoten bei
Inaktivität herunterfahren, und der Portal-Wake ist ohne gültigen
Cloudflare-Token (F1) nicht benutzbar — die Flotte wäre dann nur noch per CLI
startbar.

---

## Live-Session 2026-09-20 (durchgeführt, soweit ohne Betreiber-Secrets möglich)

**Erledigt und live gemessen:**

* **F10-Migration auf allen vier Knoten ausgeführt** (`audiomonastry-app-1`,
  `-sfu-1`, `-master-1`, `-edge-1`): Projekt und Pfad jetzt kanonisch
  (`/opt/audiomonastry`, Projekt `audiomonastry`), Volumes kopiert (Alt-Volumes
  bleiben liegen = Rückweg). Verifikation je Knoten: app `audiomonastry`+
  `-caddy` laufen, sfu `sample-monk`+`caddy` laufen (Caddy 200 lokal), master
  `master-player` `/health` → 200, edge Monitoring-Stack läuft.
* **Zwei echte Defekte der Migration dabei gefunden und behoben** (Commit
  `fix(hetzner): Migrations-Rollenform …` und der Nachlauf-Commit):
  1. `--role app` (die in der Nutzung dokumentierte Zwei-Argument-Form) endete in
     „Unbekannte Option: --role" — die Rolle konnte so nie gesetzt werden.
  2. Die Migration stoppte den Knoten, bevor sie prüfen konnte, ob der
     Rollen-Service in der Compose-Datei des Knotens überhaupt existiert: sfu-1
     lag nach `no such service: audiomonastry` unten (die Repo-Kopie dort ist vom
     18.09., der App-Service heißt da noch `sample-monk`). Jetzt wird **vor dem
     Stopp** gegen `docker compose config --services` aufgelöst (Namensvarianten
     + Schreibweisen ohne Bindestrich), fehlt ein Service bricht das Skript mit
     Exit 2 ab, und scheitert der Start im Zielprojekt, fährt es den Alt-Stand
     automatisch wieder hoch. Drei neue Tests fahren den echten Codepfad gegen
     einen Fake-`ssh` (kein Netz): Auflösung, Fail-early, unlesbare Service-Liste.
* **Prometheus auf edge-1 war in der Restart-Schleife** (`unknown long flag
  '--config.expand-env'` — der schon 2026-09-18 behobene Befund, aber die alte
  Compose-Datei lag noch auf dem Knoten). Aktuelle `docker-compose.monitoring.yml`
  plus `prometheus.yml`/`prometheus-alerts.yml`/`alertmanager.yml`/
  `grafana-provisioning`/`grafana-dashboards` nach edge-1 übertragen und den
  Stack neu erzeugt → Prometheus läuft (`Server is ready`, `/-/healthy` im
  Container), Grafana antwortet auf `127.0.0.1:3000` (200), Alertmanager läuft.
  Prometheus/Alertmanager haben bewusst keine veröffentlichten Ports (Zugriff
  per SSH-Tunnel, wie in `docker-compose.monitoring.yml` dokumentiert).
* Auf app-1 lagen veraltete SSH-Host-Keys (Knoten wurde neu provisioniert);
  lokal bereinigt (`ssh-keygen -R <ip>` für alle fünf Knoten).

**Offen geblieben (braucht Betreiber-Werte bzw. die Live-Session):**

> Historischer Abschnitt archiviert: `EVIDENCE_REGISTRY.json` →
> `R2-A2-HISTORY-DOMAIN-06`, Originalzeilen 229–244.
> Der unveränderte Wortlaut ist dort nachlesbar; keine aktuelle Dienstzusage.

---

## Restarbeiten (Betreiber-Werte)

Am 2026-09-20 **live geprüft** (lesend, ohne Schreibzugriff auf die Flotte):

> Historischer Abschnitt archiviert: `EVIDENCE_REGISTRY.json` →
> `R2-A2-HISTORY-DOMAIN-06`, Originalzeilen 251–273.
> Der unveränderte Wortlaut ist dort nachlesbar; keine aktuelle Dienstzusage.

Reihenfolge für die Live-Session (jeder Schritt mit Prüfkommando):

> Historischer Abschnitt archiviert: `EVIDENCE_REGISTRY.json` →
> `R2-A2-HISTORY-DOMAIN-06`, Originalzeilen 276–306.
> Der unveränderte Wortlaut ist dort nachlesbar; keine aktuelle Dienstzusage.

---

## F1 — Öffentlicher Zugang ist tot (P0)

> Historischer Abschnitt archiviert: `EVIDENCE_REGISTRY.json` →
> `R2-A2-HISTORY-DOMAIN-06`, Originalzeilen 311–314.
> Der unveränderte Wortlaut ist dort nachlesbar; keine aktuelle Dienstzusage.

> Historischer Abschnitt archiviert: `EVIDENCE_REGISTRY.json` →
> `R2-A2-HISTORY-DOMAIN-06`, Originalzeilen 315–326.
> Der unveränderte Wortlaut ist dort nachlesbar; keine aktuelle Dienstzusage.

> Historischer Abschnitt archiviert: `EVIDENCE_REGISTRY.json` →
> `R2-A2-HISTORY-DOMAIN-06`, Originalzeilen 327–337.
> Der unveränderte Wortlaut ist dort nachlesbar; keine aktuelle Dienstzusage.

> Historischer Abschnitt archiviert: `EVIDENCE_REGISTRY.json` →
> `R2-A2-HISTORY-DOMAIN-06`, Originalzeilen 338–342.
> Der unveränderte Wortlaut ist dort nachlesbar; keine aktuelle Dienstzusage.

**Abhängigkeit:** gültiger Cloudflare-Token (Betreiber). Alles außer dem Token ist
implementierbar.

---

## F2 — R2-Signaturfehler (P1)

**Symptom:** `/api/cloud/health` → `r2: error: The request signature we calculated does
not match the signature you provided`; `/api/session/autosave` scheitert (20× im Log);
`POST /api/upload/sample` → HTTP 500 exakt mit diesem Fehler. Supabase ist ok.

**Ursache:** Die auf app-1 verwendeten `CFS3_ACCESS_KEY_ID`/`CFS3_SECRET_ACCESS_KEY`
passen nicht zum R2-Endpoint/Bucket (`audiomonastrysamples`). Zusätzlich wird der
Fehler nur als Log-Flut sichtbar, nicht als Betriebszustand.

**Fix:**
- R2-Paar korrigieren (Access Key ID + Secret des R2-API-Tokens für den Bucket) und
  beide Rollen-Quellen (`/opt/samplemonk/.env` bzw. Portal-`envFile()`) konsistent
  machen.
- Start-Check: `/api/cloud/health` muss R2 mit einem echten HEAD/PUT-Probeobjekt
  prüfen (nicht nur Credentials vorhanden), Ergebnis in `/api/metrics` als
  `cloud.r2` sichtbar.
- Autosave: begrenzte Retries mit Backoff + einmalige Warnung statt Log-Flut; bei
  dauerhaftem Fehler Status `degraded` statt still.

**Verifikation:** `/api/cloud/health` → `r2: ok`; Autosave 200; Upload eines 3-s-WAVs
→ 200 mit Objekt-Key; Log enthält keine `SignatureDoesNotMatch`-Flut mehr.

---

## F3 — `/api/master/mix` ist auf 256 kB gedeckelt (P1)

**Symptom:** Mischen über die App scheitert mit `Payload zu gross (max 256 kB)`;
8 Spuren à 0,1 s gehen, 2 Spuren à 1 s nicht. Der Master-Dienst selbst erlaubt
64 MB / 8 Spuren / 120 s (`services/master-player/server.py`), aber
`JsonObjectBodySchema` (`src/types/zod/schemas.ts`) deckelt den App-Proxy auf 262.144 B.

**Fix (nicht das globale Schema anheben):**
- Eigene Schema-/Transfergrenze nur für die Master-Proxy-Routen (`/api/master/mix`,
  `/api/master/master`, `/api/master/analyze`) mit serverseitiger Validierung
  (≤ 64 MB, ≤ 8 Spuren, ≤ 120 s je Spur) und sauberer 413-Antwort mit Zahlen.
- Idealfall: Spuren als Binär-/Chunk-Transfer statt Base64 im JSON (Base64 bläht um
  ~33 % und passt nicht zu 64-MB-Grenzen im JSON-Parser); sonst Body-Limit für genau
  diese Routen anheben und Größe im Handler prüfen.
- Client (`src/components/MasterPlayerTerminal.tsx`) muss den neuen Fehlerpfad
  verständlich anzeigen statt generisch zu scheitern.

**Verifikation:** Test mit 4 Spuren à 30 s (realistische Größe) → 200 und hörbares
Ergebnis; Überschreitung → 413 mit klarer Meldung; `npm run test` grün.

---

## F4 — Flotte läuft veralteten Stand (P1)

**Symptom:** Deploytes Bundle 2026-09-18 17:09, Repo-HEAD 2026-09-20 14:54.
Beleg: `clock-ping`/`buildClockPong` (Commit 8a38112, 19.09.) fehlen im deployten
`/app/dist/server.cjs`; `AUDIOMONASTRY_VERSION` ist 1.210.001, aber ohne Commit-Bezug.

**Fix:**
- Deploy bäckt Commit-SHA + Build-Zeit ins Image (`BUILD_COMMIT`, `BUILD_TIME`) und
  `/api/health` zeigt beide.
- Portal-`startFleet`/`bring-up-fleet.sh` vergleicht Repo-Commit vs. Flotten-Commit
  und meldet „Flotte veraltet“ laut (Statusfeld + Ladebildschirm), statt still einen
  alten Snapshot hochzufahren.
- Snapshots tragen Commit-Label (Portal kann das schon: `/api/refresh-snapshots
  {commit,version}`) — Wake muss dieses Label prüfen, bevor es als „ready“ gilt.

**Verifikation:** frischer Deploy → `/api/health` enthält `commit: <HEAD>`; Wake aus
einem Snapshot mit altem Label meldet den Unterschied; `clock-ping` ist im Bundle
nachweisbar (`grep -c` > 0).

---

## F5 — Rate-Limit 60/min pro Studio-Token (P2)

**Symptom:** 30 parallele Requests → 300/300 `429`; 75 sequenzielle →
exakt 60×200 + 15×429, `Retry-After: 56`. `keyGenerator` ist der Studio-Token, d. h.
alle vier Nutzer und alle Flotten-Aufrufe teilen ein Budget — auch `/api/health`
(Monitoring/Alarmierung).

**Fix:**
- Schlüssel pro Session-Identität statt pro Master-Token (Portal setzt
  `STUDIO_SESSION_MODE=session` oder leitet ein Nutzerkennzeichen ab).
- `/api/health` aus dem allgemeinen Limiter nehmen (eigener Limiter, z. B. 600/min IP).
- Budget für Chunk-Upload/Agenten getrennt lassen (existiert schon), Master-Routen mit
  eigenem Budget und Backoff-Hinweis.

**Verifikation:** 4 parallele Clients mit eigenen Budgets; `/api/health` unter 1000
Requests nicht 429; Lasttest `scripts/hetzner/stress-test.mjs` ohne Rate-Limit-Fehler
auf `/api/health`.

---

## F6 — TURN/SFU fehlen im Standardpfad (P2)

**Symptom:** `/api/webrtc-config` liefert nur STUN (Mozilla/Cloudflare), kein TURN.
sfu-1 läuft, aber die Client-Transports verbinden `/sfu-signaling` **same-origin**
(app-1), wo `ENABLE_SFU` leer ist → SPA-HTML statt SFU; `SFU_ANNOUNCED_IP` auf sfu-1
leer. Für 2–8 Spieler über NAT ist Full-Mesh ohne TURN nicht tragfähig.

**Fix:**
- SFU-Rolle vollständig verdrahten: `ENABLE_SFU=1`, `SFU_ANNOUNCED_IP=<public-ip>` auf
  dem SFU-Knoten, Client-Verbindung konfigurierbar (`VITE_SFU_URL`) oder SFU auf dem
  App-Knoten betreiben; Firewall/RTP-Bereich mitprüfen.
- TURN (coturn) bereitstellen und `buildWebRtcConfigResponse` um TURN-Server +
  kurzlebige Credentials erweitern; `/api/webrtc-config` muss das ausliefern.

**Verifikation:** `/api/webrtc-config` enthält `turn:`; `node
scripts/hetzner/sfu-rtp-run.mjs` meldet `ok:true` mit `bytes>0`; zwei Browser außerhalb
des LANs verbinden sich ohne Relay-Ausfall.

---

## F7 — CORS/CSP nachschärfen (P2)

**Symptom:** `/webrtc-signaling` antwortet `Access-Control-Allow-Origin: *` auch für
`Origin: https://evil.example`; `SIGNALING_ALLOWED_ORIGINS` ist nicht auf die eigenen
Origins gesetzt (Schutz nur über das Handshake-Token). CSP ist nur Report-Only.

**Fix:** erlaubte Origins explizit setzen (Domain + lokale Test-Origins), `*` nur in
Test-Setups; CSP nach Report-Auswertung auf Enforce umstellen, `connect-src` auf die
tatsächlich genutzten Hosts begrenzen.

**Verifikation:** fremder Origin → `origin-not-allowed`; eigener Origin verbindet;
CSP-Report ohne Violations über einen Testlauf, danach Enforce.

---

## F8 — Session-Reset/Ghost-Sockets (P3)

**Symptom:** `/api/session/reset` ist in Produktion 404 → E2E-Läufe können den
serverautoritativen Zustand nicht isolieren (Fehlschläge nur aus Restzustand). Danach
meldete `/api/online` 3 Clients bei 1 echten → Ghost-Sockets nach abgebrochenen
Verbindungen.

**Fix:** token-geschützter, dev-only Reset (z. B. `x-studio-token` + `NODE_ENV!=production`
oder separater Admin-Port) für Testläufe; Socket-Sweep für tote Verbindungen
(idle/timeout-basiert) und Messwert `online` aus `activeSocketConnections`.

**Verifikation:** Reset setzt Revision/Modulstates/Locks sauber zurück; nach Abbruch
eines Clients fällt `/api/online` innerhalb eines Sweep-Intervalls auf den echten Wert.

---

## F9 — Idle-Shutdown-Signal (P3)

**Beobachtung:** `samplemonk-idle-shutdown.timer` feuert gegen ein Primärsignal, das
strukturell immer 0 ist (Caddy-308 + 401 zählen als „offline“); Idle-Log zeigt
ausnahmslos `ONLINE=0`. (Nicht selbst nachgemessen — beim Fix zuerst reproduzieren.)

**Fix:** Signal auf echte App-Nutzung stützen (`/api/online` = 0 UND keine offenen
Sockets UND kein Request in X Minuten), Log-Ausgabe mit echten Zahlen.

---

## F10 — Namespace-/Versionsparität (P3)

**Beobachtung:** Container/Projekt auf sfu-1 und master-1 heißen noch
`samplemonk-*`; Repo- und Flottennamen (`audiomonastry-*`) laufen auseinander.

**Fix:** Rollen-Deploy/Docker-Projekt auf `audiomonastry-*` ziehen (idempotent,
Rollback-fähig), Health-/Snapshot-Skripte auf beide Schreibweisen tolerant halten
(ist teilweise schon implementiert, `fleet-names.sh`).

---

## Reihenfolge

1. **Welle 1 (parallel, jetzt):** F1 Code-Anteil, F2, F3, F4.
2. **Welle 2 (nach Merge/Prüfung):** F5, F6, F7.
3. **Welle 3 (Aufräumen, jederzeit):** F8, F9, F10.

Alle Fixes müssen ohne AI/RunPod lauffähig bleiben; die AI-Rollen bleiben in diesem
Plan ausdrücklich außen vor.
