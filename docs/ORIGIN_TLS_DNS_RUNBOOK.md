# Origin-TLS & DNS – Betreiber-Runbook (anunnakitools.de)

Betriebsweg für den Produktionspfad: **Cloudflare → Portal-Worker → `origin.anunnakitools.de` → app-1 → Caddy (Origin-Zertifikat) → App**.

Bereit heißt: `https://anunnakitools.de/api/health` antwortet **HTTP 200** mit **JSON** `{"status":"ok",...}`. Alles andere (522, HTML-Body, `starting-app`) ist *nicht* bereit.

Seit PROD-P1-F4 gehören zwei weitere Felder zur Bereitschaft: `/api/health` nennt `commit` (kurzer Repo-SHA) und `buildTime`, und der Portal-Worker gibt nur noch dann `state: ready`, wenn dieser Commit zum erwarteten Stand passt. Eine **belegte Abweichung** wird als `state: stale` („Flotte laeuft Stand X, Repo ist Y") gemeldet und leitet **nicht** ins Studio weiter; „nicht prüfbar" (Image von vor F4 ohne `commit`-Feld) blockiert nicht, wird aber gemeldet. Betreiber-Ablauf für einen belegbaren Rollback: §7.1.

Zwei Fehlerklassen treten gemeinsam auf und sind in dieser Reihenfolge zu beheben: **erst** der Cloudflare-Token (Schritt 1/2), **dann** A-Record (Schritt 3), **dann** Zertifikat + Caddyfile auf dem Knoten (Schritt 4), **zuletzt** die Verifikation über die Domain (Schritt 5). Ein Zertifikatsfix am Knoten heilt keinen kaputten DNS-Record – und umgekehrt.

> Verbindliche Flotten-Zahlen (Rollen, Typen, Budgets): `docs/INFRA_KONSTITUTION.md`.
> Deploy-Mechanik und Umgebungsvariablen: `docs/HETZNER_DEPLOY.md` (§3, §4a).

Wichtige Pfade und Namen:

| Ding | Wert |
|---|---|
| Zone / Portal-Domain | `anunnakitools.de` (`PORTAL_DOMAIN`) |
| Origin-Hostname | `origin.anunnakitools.de` (`ORIGIN_HOST`) |
| Portal-Worker | `audiomonastry-portal`, Route `anunnakitools.de/*` |
| Deploy-Zielverzeichnis app-1 | `/opt/audiomonastry` |
| Caddyfile auf dem Knoten | `/opt/audiomonastry/Caddyfile` (erwartet: `Caddyfile.origin`) |
| Zertifikatsverzeichnis (Host) | `/opt/audiomonastry/certs` → im Container `./certs:/etc/caddy/certs:ro` |
| Caddy-Container | Compose-Service `caddy`, Ports 80/443 |

---

## 1. Symptom → Ursache

| Symptom (live beobachtet) | Ursache | Erster Griff |
|---|---|---|
| `https://anunnakitools.de` liefert **HTTP 522** | Cloudflare erreicht den Origin nicht: der A-Record `origin.anunnakitools.de` zeigt nicht auf die aktuelle öffentliche IPv4 von app-1 (oder der Record ist proxied). Der Worker proxied per `cf: { resolveOverride: ORIGIN_HOST }` – er löst also genau diesen Record auf. | Schritt 3, dann Schritt 2 |
| Portal hängt in **`starting-app`** | `computeStatus()` prüft `https://anunnakitools.de/api/health` über denselben `resolveOverride`-Pfad. Ohne DNS/TLS bleibt es bei `starting-app` (mit `healthError`), obwohl der Container healthy ist. | Schritt 2 für den Klartextgrund, dann 3/4 |
| `/api/health` liefert **HTML statt JSON** | Die Antwort kommt nicht von der App: entweder die Cloudflare-Fehlerseite (522) oder die Portal-Seite (`PAGE_HTML`). Der Worker proxied nur, wenn app-1 `running` **und** eine IPv4 vorhanden ist. | Schritt 3, dann Schritt 5 |
| Caddy-Log zeigt **ACME-Retry-Schleife** (`acme_client … challenge failed`) statt eines geladenen Zertifikats | Auf dem Knoten liegt die **ACME-Variante** des Caddyfiles (Repo-`Caddyfile`), nicht `Caddyfile.origin`. ACME (http-01) validiert hinter der Worker-Route nicht – der Worker fängt die Challenge ab, Let's Encrypt bricht ab, Caddy wiederholt endlos. | Schritt 4 |
| Cloudflare-API antwortet **`9109 Invalid access token`** | `syncOriginDns()` liest `CLOUDFLARE_API_TOKEN` aus der Worker-Umgebung. Fehlt/ungültig/zu eng, wird die Zonenabfrage abgelehnt und der Worker meldet `Cloudflare-Zone nicht gefunden` – die DNS-Verdrahtung bleibt aus. | Schritt 1, dann Schritt 2 |

---

## 2. Schritt 1 – Cloudflare-API-Token (Betreiber-Aktion im Dashboard)

1. Cloudflare-Dashboard → **My Profile → API Tokens → Create Token → Custom token**.
2. **Permissions**: genau eine Zeile – `Zone` · `DNS` · `Edit` (Scope `Zone:DNS:Edit`). Das enthält die Zonen-Leserechte, die `syncOriginDns()` für `GET /zones?name=…` braucht. Kein Account-Scope, kein `Zone:Settings`.
3. **Zone Resources**: *Include* → *Specific zone* → `anunnakitools.de` (Token nur für diese Zone).
4. Token erzeugen, Wert kopieren. Der Wert geht **nirgends** ins Repo, in Tickets, Chats oder Logs.
5. Token als **Worker-Secret `CLOUDFLARE_API_TOKEN`** setzen – derselbe Weg wie die übrigen Workers-Secrets (`wrangler secret put`, Secrets-Liste im Kopf von `services/portal-worker/wrangler.toml`; Betreiber-Werte liegen in `.env.portal`, nie im Repo).
6. Worker neu deployen, damit das Secret in der laufenden Version aktiv ist.

Betriebsregel: Der Token ist der **einzige** Schreibweg zum DNS-Record. Ohne ihn kann kein Repo-Code den Record setzen – der Code meldet dann nur noch ehrlich, dass ihm die Berechtigung fehlt (siehe Schritt 8).

---

## 3. Schritt 2 – Zustand prüfen (nur lesend)

```bash
bash scripts/hetzner/fleet-preflight.sh dns
```

Der Unterbefehl macht **nur GET**-Aufrufe an die Cloudflare-API (Zonen- und Record-Abfrage) und führt **keine Schreiboperation** aus. Er gibt den Zustand im Klartext aus und **niemals den Token-Wert**.

Erwartete Ausgaben:

| Lage | Ausgabe |
|---|---|
| Kein Token im Worker | `DNS-Verdrahtung fehlt: CLOUDFLARE_API_TOKEN nicht gesetzt` |
| Token ungültig oder zu eng (z. B. ohne `Zone:DNS:Edit`) | Cloudflare-Fehlercode (z. B. `9109`) **+** `DNS-Verdrahtung fehlt: Token ohne Zone:DNS:Edit` |
| Token gültig, Record fehlt/zeigt falsch | Zone und Record-ID werden genannt, dazu der aktuelle `content` und die erwartete app-1-IPv4 |
| Verdrahtung steht | Zone-ID, Record-ID `origin.<DOMAIN>`, `content ==` öffentliche IPv4 von app-1 |

Erst wenn hier alles grün ist, lohnen Schritt 3–5. Andernfalls zuerst Schritt 1 nachziehen.

---

## 4. Schritt 3 – A-Record `origin.DOMAIN`

Der Record `origin.anunnakitools.de` muss **A** sein, auf die **öffentliche IPv4 von app-1** zeigen und **`DNS only`** stehen (`proxied = false`).

- Warum `DNS only`: Der Worker proxied selbst und setzt `resolveOverride: ORIGIN_HOST`. Ist der Record proxied, löst `resolveOverride` auf Cloudflare-Edge-IPs auf – der Pfad bricht.
- Die app-1-IPv4 ist **flüchtig**: jeder Wake erzeugt einen neuen Knoten mit neuer IPv4. Deshalb schreibt der Portal-Worker den Record bei jedem Fleet-Start selbst neu (`syncOriginDns()`, `PATCH …/dns_records/<id>` mit `content = app-1-IPv4`). Nach jedem Provision-Vorgang ist der Record also **automatisch** aktuell – nur bei fehlendem Token nicht.
- Manuell (nur wenn der automatische Weg nicht greifbar ist): Cloudflare-Dashboard → Zone `anunnakitools.de` → DNS → Record `origin` → Typ `A`, Inhalt = app-1-IPv4, Proxy-Status **DNS only**. Alternativ per API, wenn Zone- und Record-ID aus Schritt 2 bekannt sind:

```bash
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/<zone-id>/dns_records/<record-id>" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "<öffentliche-ipv4-von-app-1>", "type": "A", "proxied": false}'
```

Die öffentliche IPv4 von app-1 liefert das Portal selbst: `GET /api/status` enthält das Feld `appIp` (Session-Cookie nötig, siehe Schritt 5).

---

## 5. Schritt 4 – Origin-Zertifikat + Caddyfile auf app-1

**Standard im Repo: `scripts/hetzner/Caddyfile.origin`.** Beide Installationswege setzen sie als Default:

- **Portal-Worker (Cloud-Init der Rolle `app`)**: dekodiert `ORIGIN_CERT`/`ORIGIN_KEY` aus seiner Umgebung (base64) nach `/opt/audiomonastry/certs/` und kopiert `scripts/hetzner/Caddyfile.origin` nach `Caddyfile`.
- **`deploy.sh`**: überträgt `Caddyfile` **bewusst nicht** per rsync (INFRA-HETZNER-002) und installiert auf Wunsch die Zertifikate, damit ein Deploy die Origin-Variante nicht auf ACME zurückdreht.

Die Datei erwartet:

```text
/etc/caddy/certs/origin.crt
/etc/caddy/certs/origin.key      # tls-Direktive in Caddyfile.origin
```

Mount: `./certs:/etc/caddy/certs:ro` (siehe `docker-compose.hetzner.yml`). Rechte auf dem Host: **Verzeichnis `/opt/audiomonastry/certs` 700**, **Dateien 600** – die Schlüsseldatei bleibt damit für alles außer Caddy unlesbar. Die Zertifikatswerte werden aus der Umgebung gelesen und **nie ausgegeben** (kein `echo "$ORIGIN_KEY"`, keine Inhalte in Tickets/Logs).

`DOMAIN` kommt aus der Rollen-`.env` der Rolle `app` und füllt in `Caddyfile.origin` sowohl den Serverblock als auch das Zertifikatspaar – ohne gesetztes `DOMAIN` würde Caddy auf `:80` zurückfallen.

**ACME ist im Origin-Betrieb kein Default.** Der Knoten läuft hinter der Cloudflare-Worker-Route; Let's Encrypt kann dort nicht validieren (Retry-Schleife). Nur ein **bewusster** Wechsel auf die ACME-Variante lädt das Repo-`Caddyfile`:

```bash
DEPLOY_INSTALL_CADDYFILE=1 bash deploy.sh
```

Manuell (Reparatur eines Knotens, auf dem die ACME-Variante liegt):

```bash
SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
ssh -i "$SSH_KEY" root@<app-1-ip> '
  set -e
  cd /opt/audiomonastry
  cp scripts/hetzner/Caddyfile.origin Caddyfile
  mkdir -p certs && chmod 700 certs
  test -s certs/origin.crt && test -s certs/origin.key   # vorhanden?
  chmod 600 certs/origin.crt certs/origin.key
  docker compose -f docker-compose.hetzner.yml up -d caddy
  docker compose -f docker-compose.hetzner.yml restart caddy
'
```

Fehlen `certs/origin.crt`/`origin.key`: `ORIGIN_CERT`/`ORIGIN_KEY` im Portal-Secret prüfen (base64, SAN `*.anunnakitools.de`) – **nicht** in die ACME-Variante ausweichen.

---

## 6. Schritt 5 – Verifikation

```bash
# 1) Statuscode + Body über die Domain (HTML oder 522 zählt NICHT als bereit)
curl -s -o /tmp/health.body -w 'http=%{http_code}\n' https://anunnakitools.de/api/health
cat /tmp/health.body     # erwartet: {"status":"ok","version":"...","commit":"<kurzer SHA>","buildTime":"..."}

# 2) Portal-Zustand inkl. DNS-Feld mit Klartextgrund
#    (Login-Cookie genau wie fleet-preflight.sh; ADMIN_USER/ADMIN_PASSWORD aus .env.deploy)
curl -s -c /tmp/portal.cookies -H 'content-type: application/json' \
  -d "{\"user\":\"$ADMIN_USER\",\"pass\":\"$ADMIN_PASSWORD\"}" \
  https://anunnakitools.de/api/login >/dev/null
curl -s -b /tmp/portal.cookies https://anunnakitools.de/api/status | python3 -m json.tool

# 3) Beide Schreib-/Verdrahtungspfade liefern dieselbe Klartextdiagnose
curl -s -b /tmp/portal.cookies -X POST https://anunnakitools.de/api/wire-fleet | python3 -m json.tool
curl -s -b /tmp/portal.cookies -X POST https://anunnakitools.de/api/wake      | python3 -m json.tool
```

Abnahmekriterien:

- `/api/health` → **200** und Body-JSON `status: ok`. Ein HTML-Body (Portal-Seite oder Cloudflare-Fehlerseite) oder 522 ist **kein** Beleg.
- `/api/health` → `commit` **entspricht dem Repo-Stand** (kurzer SHA, seit PROD-P1-F4). Die Version allein genügt nicht: sie ändert sich nicht mit jedem Commit. Prüfen mit
  `bash scripts/hetzner/fleet-preflight.sh check` (vergleicht Repo-Commit gegen `/api/health`) –
  ohne Werkzeug: `curl -s https://anunnakitools.de/api/health | python3 -c 'import json,sys; print(json.load(sys.stdin).get("commit"))'` gegen `git rev-parse --short HEAD` halten.
  Meldet der Knoten **keinen** `commit` (Image von vor F4), ist die Parität *nicht prüfbar*: das blockiert nicht, muss aber als Restpunkt im Bericht stehen.
- `GET /api/status` → `state: ready` und der DNS-Zustand als Feld mit **Klartextgrund** (z. B. `DNS-Verdrahtung fehlt: Token ohne Zone:DNS:Edit`). Meldet der Worker `state: stale` mit „Flotte laeuft Stand X, Repo ist Y", ist die Parität verletzt: **kein** Weiterleiten ins Studio, erst neu deployen (oder bewusst `--allow-stale`).
- `POST /api/wire-fleet` → Feld `dns`; `POST /api/wake` → Feld `wiring.dns`. Beide nennen denselben Klartextgrund wie Schritt 2 – Portal und Preflight dürfen sich nicht widersprechen.
- Kein `acme_client … challenge failed` mehr im Caddy-Log.

---

## 7. Rollback & Aufräumen (Kurzliste)

```bash
SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"

# Caddy neu starten (Caddyfile-/Zertifikatswechsel greift erst nach Neustart)
ssh -i "$SSH_KEY" root@<app-1-ip> 'cd /opt/audiomonastry && docker compose -f docker-compose.hetzner.yml restart caddy'

# Logs (Caddy zuerst: dort steht ACME vs. geladenes Zertifikat)
ssh -i "$SSH_KEY" root@<app-1-ip> 'cd /opt/audiomonastry && docker compose -f docker-compose.hetzner.yml logs --tail=100 caddy'

# Welche Caddyfile liegt wirklich auf dem Knoten?
ssh -i "$SSH_KEY" root@<app-1-ip> 'grep -n "tls /etc/caddy/certs" /opt/audiomonastry/Caddyfile'
#   erwartet: tls /etc/caddy/certs/origin.crt /etc/caddy/certs/origin.key
#   (die ACME-Variante hat hier KEINE tls-Zeile mit /etc/caddy/certs/)

# Zertifikate: NUR Existenz und Rechte prüfen – keine Zertifikatsinhalte posten
ssh -i "$SSH_KEY" root@<app-1-ip> 'ls -ld /opt/audiomonastry/certs && ls -l /opt/audiomonastry/certs'
#   erwartet: drwx------ + origin.crt/-key mit -rw------- (700/600)
```

| Aufräumschritt | Kommando / Prüfung |
|---|---|
| ACME-Variante liegt auf dem Knoten | Repo-`Caddyfile` durch `scripts/hetzner/Caddyfile.origin` ersetzen, Caddy neu starten (Schritt 4) |
| Certs-Verzeichnis leer oder falsch berechtigt | `chmod 700 certs`, `chmod 600 certs/origin.*`, dann Caddy neu starten |
| DNS-Änderung wirkt nicht sofort | Cloudflare-Edge cached DNS bis zur TTL; im Zweifel Record in Schritt 2 erneut lesen statt zu raten |
| Portal bleibt `starting-app` trotz 200 auf `/api/health` | Session/Status neu abrufen; der Status prüft über dieselbe Domain – bleibt er stehen, domänenseitig messen (Schritt 5.1) |

---

## 7.1 Rollback auf ein altes Versionslabel (PROD-P1-F4)

Seit PROD-P1-F4 trägt jedes Image drei Stempel, die `/api/health` ausgibt. Damit ist ein Rollback
**belegbar** statt gefühlt:

| Feld | Quelle | Aussage |
|---|---|---|
| `version` | `package.json` (Build-Arg `BUILD_VERSION`) | Release-Version – ändert sich **nicht** mit jedem Commit |
| `commit` | `git rev-parse --short HEAD` (Build-Arg `BUILD_COMMIT`) | Repo-Stand, der im Image steckt |
| `buildTime` | UTC-Zeit beim Build (Build-Arg `BUILD_TIME`) | wann das Image gebaut wurde |

**1. Welcher Stand läuft (vor jedem Rollback messen):**

```bash
curl -s https://anunnakitools.de/api/health | python3 -m json.tool
#   → {"status":"ok","version":"1.210.001","commit":"ae5e749","buildTime":"2026-09-20T15:04:05Z"}
git rev-parse --short HEAD        # Repo-Stand zum Vergleich
bash scripts/hetzner/fleet-preflight.sh check   # vergleicht beide Seiten, Exit 1 bei Abweichung
```

**2. Laufenden Stand sichern bzw. altes Label inspizieren (auf dem Knoten):**

```bash
SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/id_ed25519}"
# Welchen Stempel trägt ein vorhandenes Image? (die Stempel stecken als ENV im Image)
ssh -i "$SSH_KEY" root@<app-1-ip> "docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' audiomonastry:hetzner | grep AUDIOMONASTRY_"
#   → AUDIOMONASTRY_VERSION=… AUDIOMONASTRY_COMMIT=… AUDIOMONASTRY_BUILD_TIME=…
# Vor jeden Rollback: aktuellen Stand als benanntes Label wegschreiben
ssh -i "$SSH_KEY" root@<app-1-ip> "docker tag audiomonastry:hetzner audiomonastry:hetzner-$(git rev-parse --short HEAD)"
```

**3. Rollback auf das Vorversions-Label (das Image, das `deploy.sh` beim letzten Deploy gesichert hat):**

```bash
ssh -i "$SSH_KEY" root@<app-1-ip> 'docker tag audiomonastry:hetzner-rollback audiomonastry:hetzner && \
  cd /opt/audiomonastry && docker compose -f docker-compose.hetzner.yml up -d --no-build --force-recreate audiomonastry'
# Danach: welcher Stand läuft jetzt?
curl -s https://anunnakitools.de/api/health | python3 -m json.tool   # commit = alter SHA
```

**4. Rollback auf ein benanntes Zwischen-Label** (z. B. `audiomonastry:hetzner-<alter-sha>` aus Schritt 2):
`docker tag audiomonastry:hetzner-<alter-sha> audiomonastry:hetzner` und wie in Schritt 3 neu erzeugen.

> `DEPLOY_COMMIT=<alt>` setzt **nur den Stempel** im neuen Image – der Code kommt weiter aus dem
> Arbeitsbaum. Für einen echten Rollback muss der alte Repo-Stand ausgecheckt sein
> (`git checkout <sha>`), sonst behauptet `/api/health` einen Stand, der nicht drin ist.

**5. Erwartete Reaktion des Gates nach einem Rollback:** Der Knoten läuft dann bewusst auf einem
*fremden* Stand – Preflight, Wake und `deploy.sh` melden also `Flotte laeuft Stand <alt>, Repo ist
<neu>` und blockieren ohne Freigabe:

```bash
bash scripts/hetzner/fleet-preflight.sh check  --allow-stale   # bewusst abweichend weiterarbeiten
bash scripts/hetzner/fleet-preflight.sh apply  --allow-stale
DEPLOY_ALLOW_STALE=1 bash deploy.sh                            # im deploy.sh-Pfad
# Worker-Pin (dauerhaft, wrangler.toml): ALLOW_STALE = "1"
```

Die Meldung bleibt dabei **sichtbar** – sie wird nur nicht mehr blockierend. Die Freigabe endet mit
dem nächsten normalen Deploy (Stempel = Repo-Commit → `state: ready`, keine Warnung). „Nicht
prüfbar" (Image von vor F4 ohne `commit`-Feld) blockiert nie, wird aber genauso gemeldet.

---

## 8. Ehrlichkeitsgrenze: Repo-Code vs. offene Betreiber-Aktion

**Repo-Code (löst sich selbst):**

- Portal-Worker (`services/portal-worker/src/index.js`): setzt bei jedem Wake den `origin`-Record (`syncOriginDns()`), öffnet die Cloudflare-Firewall-Ranges für 80/443, installiert im Cloud-Init der Rolle `app` Zertifikate + `Caddyfile.origin`; meldet DNS-Fehler im Ergebnis von `/api/wake` (`wiring.dns`), `/api/wire-fleet` (`dns`) und `/api/status`.
- `deploy.sh`: schließt `Caddyfile` vom rsync aus (INFRA-HETZNER-002), installiert Zertifikate mit Rechten 600 unter `/opt/audiomonastry/certs`, ACME nur bewusst per `DEPLOY_INSTALL_CADDYFILE=1`.
- `scripts/hetzner/fleet-preflight.sh dns`: diagnostiziert Token/Zone/Record im Klartext (nur GET, ohne Token-Ausgabe).
- Commit-Paritaet (PROD-P1-F4): `deploy.sh` stempelt Commit + Build-Zeit ins Image, `/api/health` gibt sie aus, und `deploy.sh` / `fleet-preflight.sh` / Portal-Worker vergleichen sie über `scripts/hetzner/lib/build-parity.sh` (kurzer SHA trifft langen). Der frühere Drift (Image 18.09. bei Repo-Stand 20.09.) wird damit laut statt still.

**Offene Betreiber-Aktion (nicht durch Code ersetzbar):**

- Ein gültiger Cloudflare-API-Token mit `Zone:DNS:Edit` für die Zone `anunnakitools.de`, gesetzt als Worker-Secret `CLOUDFLARE_API_TOKEN`. Ohne ihn schlägt jede DNS-Verdrahtung fehl, und der Code kann das nur noch melden.
- Der Origin-Zertifikatswert selbst (`ORIGIN_CERT`/`ORIGIN_KEY` im Portal-Secret): Bereitstellen/Rotieren ist Betreiberarbeit; der Code bringt vorhandene Werte nur auf den Knoten.
- Alles außerhalb des Repos: Cloudflare-Propagation/TTL, Edge-Cache und die öffentliche IPv4-Zuteilung von app-1 sind nicht durch das Repo prüfbar – messbar ist nur der HTTP-Statuscode über die Domain (Schritt 5).
