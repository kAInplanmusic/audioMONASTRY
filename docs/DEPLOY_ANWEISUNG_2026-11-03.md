# Deploy-Anweisung (atomar) — gültig ab 2026-11-03

Ziel: audioMONASTRY-Flotte starten, sobald Guthaben auf RunPod liegt.
Jeder Schritt hat: **Befehl → Erwartung → Abbruchkriterium**. Nichts überspringen,
nichts „schnell mal" variieren. Alle Befehle aus dem Repo-Root:

```bash
cd /mnt/wd-elements/Medien/Projekte/audioMONASTRY
set -a; . ./.env.deploy; set +a
```

Harte Regeln (im Code erzwungen, nicht verhandelbar):
- max **1 USD/h pro Instanz**
- nur **RTX 4090 / RTX 5090 / A40**
- `scripts/runpod-pods.py` wirft `ConfigError` bei Verstoß, bevor ein HTTP-Aufruf passiert

---

## Phase 0 — Preflight (kostet nichts)

### 0.1 Guthaben prüfen
```bash
curl -s -H "Authorization: Bearer $RUNPOD_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"query":"{ myself { clientBalance currentSpendPerHr } }"}' \
     https://api.runpod.io/graphql
```
**Erwartet:** `clientBalance` ≥ 3.00.
**Abbruch:** < 3.00 → kein Start. Rechnung: 5 × A40 ≈ **1,75 $/h**; 3 $ ≈ 1,7 h Laufzeit.

### 0.2 Nichts läuft doppelt
```bash
curl -s -H "Authorization: Bearer $RUNPOD_API_KEY" \
     https://rest.runpod.io/v1/pods | python3 -c "import sys,json;print(len(json.load(sys.stdin)),'Pods')"
```
**Erwartet:** `0 Pods`. Sonst erst `down` (Phase 5), dann weiter.

### 0.3 Gewichte vollständig
```bash
python3 scripts/runpod-pods.py weights
```
**Erwartet:** 20 Zeilen mit `✔` und `Alle Gewichte vorhanden.` (Exit 0).
**Abbruch:** irgendein `✖` → `python3 scripts/weights-mirror.py --yes` nachziehen,
danach 0.3 wiederholen. (Voller Spiegel über die lokale Leitung ≈ 30 h; im
Rechenzentrum ≈ 40 min.)

### 0.4 Plan und Kostendeckel
```bash
python3 scripts/runpod-pods.py plan
```
**Erwartet:**
```
brain … 29G 0.32 €/h …   ears … 26G …   voice … 39G …   stems … 14G …   music … 31G …
Summe höchstens 1.61 €/h (Budget 4.00 €/h)
```
**Abbruch:** irgendeine Zeile mit `PROBLEM:` → Ursache lesen, nicht starten.

### 0.5 Token-Länge
```bash
python3 -c "import os;print(len(os.environ.get('AI_POD_TOKEN','')))"
```
**Erwartet:** ≥ 32 (aktuell 48). Sonst `ConfigError` in Phase 1.

---

## Phase 1 — Flotte starten (ab hier laufen Kosten)

```bash
python3 scripts/runpod-pods.py up --yes --wait 900 2>&1 | tee /tmp/deploy-$(date +%F-%H%M).log
```

**Erwartet je Pod, in dieser Reihenfolge (startOrder):**
```
+ brain: angelegt <id> (0.35 $/h)
  ✔ brain bereit (https://<id>-8000.proxy.runpod.net)
+ ears:  …
```
am Ende: `Ist-Kosten: 1.75 $/h ≈ 1.61 €/h` und je Pod eine Zeile
`RP_POD_ID_<ROLLE>=<id>`.

**Timing-Erwartung (wichtig, nichts vorzeitig abbrechen):**
`pod_start.py` lädt die Gewichte aus R2 und entpackt sie. Gemessen/abgeleitet:
- Download im Rechenzentrum: whisper 24,7 GB ≈ 1–2 min; acestep 21,5 GB ≈ 1–2 min
- Entpacken + Modell in VRAM: 2–5 min je Pod
- **Realistisch 8–15 min pro Pod.** `--wait 900` (15 min) ist die richtige Grenze.

**Abbruchkriterien:**
- `ConfigError: … GPU … ist nicht erlaubt` → **richtig so**, nichts umgehen.
- `Gewichte fehlen im Speicher` → Phase 0.3.
- `Anlegen fehlgeschlagen (HTTP 500) … no instances currently available` →
  GPU-Typ ausgebucht. **Nicht** auf eine größere/teurere Karte ausweichen.
  Warten oder nur die verfügbaren Rollen starten:
  `python3 scripts/runpod-pods.py up --yes --only brain,ears --wait 900`
- Nach 15 min kein `/ready` → Phase 2.2 prüft den Grund; danach Phase 5 (`down`).

---

## Phase 2 — Bereitschaft je Pod prüfen (kostet nichts extra)

### 2.1 Liveness (ohne Token, muss 200 sein)
```bash
for id in $(grep -o 'RP_POD_ID_[A-Z]*=.*' /tmp/deploy-*.log | cut -d= -f2); do
  echo -n "$id "; curl -s -o /dev/null -w '%{http_code}\n' https://$id-8000.proxy.runpod.net/health
done
```
**Erwartet:** je `200`. `404` = uvicorn noch nicht gestartet → warten, nicht neu starten.

### 2.2 Readiness mit Grund (Token nötig)
```bash
curl -s -H "Authorization: Bearer $AI_POD_TOKEN" https://<id>-8000.proxy.runpod.net/ready
```
**Erwartet:** `{"status":"ready","version":"1.0.0"}`.
`503 loading_models` → weiter warten.
`503 failed` → `errors`-Feld lesen (fast immer fehlendes/abweichendes Gewicht).

### 2.3 Modelle im VRAM (Beweis, dass wirklich geladen wurde)
```bash
curl -s -H "Authorization: Bearer $AI_POD_TOKEN" https://<id>-8000.proxy.runpod.net/status
```
**Erwartet:** `"models_ready": true` **und `gpu.usedGb > 0`**.
`usedGb = 0` bei `models_ready: true` = Modelle nur registriert, nicht geladen → Abbruch.

### 2.4 Echter Inferenztest je Rolle
```bash
# brain (Text)
curl -s -X POST -H "Authorization: Bearer $AI_POD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"input":{"task":"llm","model":"qwen3-4b","input":{"prompt":"Antworte mit: OK","max_tokens":8}}}' \
  https://<brain-id>-8000.proxy.runpod.net/runsync

# ears (Audio-Klassifikation, echte Datei aus R2 nötig)
curl -s -X POST -H "Authorization: Bearer $AI_POD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"input":{"task":"classify","model":"ast-audioset","input":{"audio_url":"<presigned wav>"}}}' \
  https://<ears-id>-8000.proxy.runpod.net/runsync
```
**Erwartet:** `"status":"COMPLETED"` und `output.status":"success"`.
`MODEL_UNAVAILABLE` → Modell nicht geladen (siehe 2.3).

---

## Phase 3 — Server/App ausrollen

```bash
export DEPLOY_HOST=<server-ip>
export DEPLOY_DOMAIN=anunnakitools.de          # bereits in .env.deploy
export DEPLOY_SSH_KEY=$HOME/.ssh/id_ed25519
export DEPLOY_IMAGE_SOURCE=registry            # kein 1,4-GB-Upload je Knoten
export DEPLOY_SMOKE=1
./deploy.sh
```
**Erwartet:** Health-Wait erfolgreich, Smoke-Test grün, Hinweis auf Rollback-Image.
Die Pod-IDs aus Phase 1 in die Server-`.env` übernehmen (`RP_POD_ID_*`).

---

## Phase 4 — Abnahme

```bash
curl -fsS https://anunnakitools.de/api/health          # 200
curl -fsS https://anunnakitools.de/api/ai/health       # 200, provider runpod
```
Dann im Browser: Login mit einem der 4 Test-Accounts, ein TTS-Prompt, ein
Stem-Split. Erwartet: Audio kommt zurück, keine 5xx im Netzwerk-Tab.

---

## Phase 5 — Kosten stoppen

```bash
python3 scripts/runpod-pods.py down --yes
curl -s -H "Authorization: Bearer $RUNPOD_API_KEY" https://rest.runpod.io/v1/pods | head -c 200
```
**Erwartet:** `[]`. Zusätzlich Hetzner prüfen, falls Phase 3 einen Server erstellt hat:
```bash
curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" https://api.hetzner.cloud/v1/servers | head -c 200
curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" https://api.hetzner.cloud/v1/floating_ips | head -c 200
```

---

## Fehlerbild → Ursache → Maßnahme

| Symptom | Ursache | Maßnahme |
|---------|---------|----------|
| `ConfigError … GPU … nicht erlaubt` | Pool enthält fremde Karte | Fleet korrigieren, nicht umgehen |
| `HTTP 500 … no instances currently available` | Karte ausgebucht | warten / `--only` mit verfügbaren Rollen |
| `/health` 404 nach >15 min | `pod_start.py` hängt beim Laden | `down`, Pod einzeln mit `--only <rolle>` neu |
| `/ready` 503 `failed` | Gewicht fehlt/Hash falsch | `weights` prüfen, ggf. neu spiegeln |
| `/status` `usedGb: 0` bei `models_ready` | Modelle nicht im VRAM | Pod neu starten, `AI_RESIDENT_ONLY=1` prüfen |
| `MODEL_UNAVAILABLE` bei Inferenz | Modell nicht geladen | wie oben |
