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

| Fix | Merge | Was code-seitig belegt ist | Offen (live/Betreiber) |
| --- | --- | --- | --- |
| F1 | 6c66a6f | Klartext-Diagnose für Cloudflare-Fehler, `{dryRun}`-DNS-Prüfung, `ready` nur bei JSON-200, Origin-Caddyfile + Zertifikat als Rollen-Default | gültiger CF-Token (Betreiber), origin-A-Record auf app-1, `curl https://anunnakitools.de/api/health` |
| F2 | 3d1d9b3 | eine Credential-Auflösung (`resolveR2Config`), echter R2-Probe-Healthcheck (`cloud.r2`), Autosave mit Backoff + gedrosselter Warnung | gültiges R2-Paar (Betreiber), `npm run r2:check` auf app-1, 3-s-WAV-Upload |
| F3 | 6ac391c | eigene Master-Limits (64 MB / 8 Spuren / 120 s) nur für die drei Routen, 413 mit Zahlen, Client-Fehlerpfad | Live-Mischlauf 4 Spuren à 30 s → 200 + Hörprobe |
| F4 | 38875df | Commit + Build-Zeit im Image, `/api/health` nennt sie, Paritäts-Gate in `deploy.sh`/`fleet-preflight.sh`, Portal meldet Drift | frischer Deploy → `commit == HEAD`; Wake aus altem Snapshot meldet die Abweichung |
| F5 | bca117f | Limiter-Schlüssel je Session/Nutzer, `/api/health` mit eigenem IP-Budget | Lasttest gegen die Flotte, 4 parallele Clients live |
| F6 | b962ecb | `wire-rtc.sh` + `rtc-fleet.sh` als eine Quelle, coturn im Standardpfad, `turn:`-Einträge mit kurzlebigen Credentials, kein same-origin-Rückfall | zwei echte Browser außerhalb des LANs, ACME für `sfu.<domain>` (DNS = Betreiber) |
| F7 | bca117f | Origins aus `APP_DOMAIN` ohne `*`, CSP abgeleitet + Report-Ziel, `CSP_MODE=enforce` schaltbar | Report-Auswertung, dann Enforce-Entscheidung; fremder Origin live abgewiesen |
| F8 | 12d2273 | Reset mit zwei Schlössern + Rücklesebeleg, `/api/session/state`, `online` aus dem Socket-Registry mit Sweep | TCP-Abriss ohne Close-Paket real (Paketverwerfen) |
| F9 | 12d2273 | `/api/idle-signal` mit echten Regeln, Timer fragt die App (8080) statt Caddy, fail-safe bei unlesbarem Signal | echter systemd-Timer-Lauf auf einem Hetzner-Knoten |
| F10 | 93fca09 | `fleet-names.sh` als Namensquelle, Compose-Projekt `audiomonastry`, Migration idempotent ohne `down -v` | Live-Migration sfu-1/master-1 + 4-User-E2E danach |

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

## Restarbeiten (live, Betreiber) — Stand 2026-09-20, alles vorgemessen

Am 2026-09-20 **live geprüft** (lesend, ohne Schreibzugriff auf die Flotte):

* Flotte läuft: `audiomonastry-app-1` 142.132.229.71, `sfu-1` 142.132.231.146,
  `ai-1` 178.105.66.67, `master-1` 167.233.112.182, `edge-1` 167.233.192.196
  (`bash scripts/hetzner/fleet-status.sh`).
* app-1 fährt `/opt/samplemonk` im Compose-Projekt **samplemonk**
  (`/audiomonastry` + `audiomonastry-caddy`), `/opt/audiomonastry` fehlt,
  Volumes `samplemonk_caddy_{config,data}` — genau der F10-Befund, jetzt belegt:
  `bash scripts/hetzner/migrate-project-name.sh 142.132.229.71 --role app --dry-run`.
* `http://142.132.229.71:8080/api/health` (auf dem Knoten) liefert weiterhin nur
  `{"status":"ok","version":"1.210.001"}` — kein `commit`/`buildTime`, also der
  Stand vom 18.09. (F4-Befund reproduziert).
* DNS unverändert kaputt: `anunnakitools.de` und **auch**
  `origin.anunnakitools.de` zeigen auf Cloudflare-IPs (104.21.46.111 /
  172.67.168.116), `sfu.anunnakitools.de` existiert nicht;
  `https://anunnakitools.de/api/health` → HTTP 000.
* **Alle fünf Cloudflare-Credentials sind ungültig** — gemessen mit
  `python3 scripts/hetzner/cf-token-diagnose.py` (nur lesend, gibt nie Werte
  aus): `CLOUDFLARE_API_TOKEN`, `CF_API_KEY`, `CF_ACCOUNT_TOKEN` in
  `.env.portal` und `.env.deploy` antworten durchweg mit `1000 Invalid API
  Token`, Zonenzugriff 0. Das ist der harte Blocker für F1 (und für das
  Portal-gesteuerte Flotten-Wake).
* Auf app-1 lagen veraltete SSH-Host-Keys (Knoten wurde neu provisioniert);
  lokal bereinigt (`ssh-keygen -R <ip>` für alle fünf Knoten).

Reihenfolge für die Live-Session (jeder Schritt mit Prüfkommando):

1. **Gültigen Cloudflare-Token** mit `Zone:DNS:Edit` für `anunnakitools.de`
   hinterlegen (`.env.portal` → Worker-Variable), dann
   `python3 scripts/hetzner/cf-token-diagnose.py` → `success=True`, Zonen ≥ 1.
2. **Origin-DNS** auf die app-1-IP patchen (schreibfrei vorher prüfen:
   `bash scripts/hetzner/fleet-preflight.sh dns`; schreiben lässt der
   Portal-Worker per `POST /api/wire-fleet`).
3. **F10-Migration** app-1: `bash scripts/hetzner/migrate-project-name.sh
   142.132.229.71 --role app --dry-run` → danach ohne `--dry-run` (idempotent,
   `down` ohne `-v`, Volumes werden kopiert, Alt-Stand bleibt
   rückrollbar). Für `sfu-1`/`master-1` mit `--role sfu|master` wiederholen.
4. **F4-Deploy** mit Stempel und Origin-Zertifikat:
   `DEPLOY_HOST=142.132.229.71 DEPLOY_DOMAIN=anunnakitools.de bash deploy.sh`
   (die Zertifikatswerte `ORIGIN_CERT`/`ORIGIN_KEY` liegen in `.env.portal`);
   Prüfung: `curl -s https://anunnakitools.de/api/health` enthält
   `commit: <HEAD>` und `curl -s https://…/api/health | grep -c clock-ping`.
5. **F5/F6/F7 live:** `node scripts/hetzner/stress-test.mjs` (kein 429 auf
   `/api/health`); `curl -s https://…/api/webrtc-config` enthält `turn:`;
   `node scripts/hetzner/sfu-rtp-run.mjs` → `ok:true`; fremder Origin →
   `origin-not-allowed`; `/api/security/csp-report` auswerten und danach
   `CSP_MODE=enforce` entscheiden (Worker-Variable + Deploy).
6. **F8/F9 live:** auf dem App-Knoten
   `AUDIOMONASTRY_TEST_RESET=1` + Studio-Token → `POST /api/session/reset` (200)
   und `GET /api/state`; Idle: `GET /api/idle-signal` und ein echter Lauf des
   systemd-Timers (`--dry-run` vorher).
7. **F2 live:** gültiges R2-Paar in die Rollen-`.env` von app-1 (kanonisch
   `CFS3_*`), dann `npm run r2:check` → Exit 0,
   `curl -s 'https://…/api/cloud/health?probe=1'` → `r2: ok`, 3-s-WAV-Upload →
   200.
8. **F3 live:** Mischen mit 4 Spuren à 30 s über die App → 200 + Hörprobe;
   Überschreitung → 413 mit Zahlenmeldung.

---

## F1 — Öffentlicher Zugang ist tot (P0)

**Symptom:** `https://anunnakitools.de` → 522/Timeout, `/api/health` über die Domain
HTTP 000 nach 12 s. Direkter IP-Zugriff ist by design dicht (Firewall nur
Cloudflare-CIDRs).

**Belegte Ursachen (drei, alle nötig):**
1. Alle Cloudflare-Credentials (`CLOUDFLARE_API_TOKEN`, `CF_API_KEY`,
   `CF_ACCOUNT_TOKEN`) in `.env.portal` → `9109 Invalid access token`; der
   Portal-Worker scheitert in `syncOriginDns()` mit „Cloudflare-Zone nicht gefunden“.
2. `origin.anunnakitools.de` zeigt auf Cloudflare-IPs (104.21.46.111/172.67.168.116)
   statt auf die aktuelle app-1-IP → `resolveOverride` des Workers landet in der Zone
   selbst (522), kein Cloudflare-Treffer in 2 Tagen Caddy-Access-Log.
3. `/opt/samplemonk/certs` ist leer und deployt ist die ACME-Variante des Caddyfiles;
   http-01/tls-alpn-01 laufen in die Cloudflare-Worker-Route → Endlos-Retry, kein Zert.
   Die Origin-CA-Credentials in `.env.portal` sind dagegen gültig
   (SAN `*.anunnakitools.de`, notAfter 2041, Paar-Prüfung ok).

**Fix:**
- Gültigen Cloudflare-Token mit `Zone:DNS:Edit` für `anunnakitools.de` in
  `.env.portal` hinterlegen; `syncOriginDns()` muss den Fehler laut melden
  (kein stiller `console.warn`) und `origin.<domain>` als DNS-only-A-Record auf die
  app-1-IP patchen.
- `scripts/hetzner/Caddyfile.origin` als Rollen-Caddyfile installieren, ORIGIN_CERT/KEY
  nach `/opt/samplemonk/certs/{origin.crt,origin.key}` legen, Caddy neu erzeugen
  (`up -d --force-recreate caddy`), ACME-Variante nicht mehr verwenden.
- Portal-Status: „ready“ erst, wenn `https://<domain>/api/health` JSON 200 liefert
  (nicht bei 522/HTML); Health-Fehler im Ladebildschirm sichtbar machen.

**Verifikation:** `curl https://anunnakitools.de/api/health` → 200 JSON mit
`{"status":"ok","version":...}`; Zertifikat von der Domain aus sichtbar; `openssl
s_client -servername anunnakitools.de` ohne `internal error`; Caddy-Log zeigt
Cloudflare-Treffer.

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
