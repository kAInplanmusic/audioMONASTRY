# audioMONASTRY — DEPLOY-RUNBOOK

> **Zweck:** Immer derselbe Ablauf. Jeder Deploy nach dieser Datei.
> **Kosten:** ~2,8 €/h (Hetzner 4 Rollen + 8 RunPod-Pods). Nach 15 Min Idle
> räumt der Idle-Teardown-Cron alles ab → 0 €.
> **Letzte Aktualisierung:** 2026-11-09

---

## 0. Voraussetzungen (einmalig, müssen stimmen)

| Was | Wo | Prüfung |
|-----|-----|---------|
| Secrets | `.env.deploy` im Repo-Root | `test -f .env.deploy` |
| Hetzner-Token | `HCLOUD_TOKEN` in `.env.deploy` | `curl -s -H "Authorization: Bearer $HCLOUD_TOKEN" https://api.hetzner.cloud/v1/servers \| jq '.servers \| length'` |
| RunPod-Key | `RP_API_KEY` in `.env.deploy` | `curl -s -H "Authorization: Bearer $RP_API_KEY" https://api.runpod.io/v2/pods` |
| Registry-Credential | `RP_REGISTRY_AUTH_ID=cmvae16im0013wtg4cw2pbp3j` | **Nur dieses funktioniert.** Das „Github"-Credential liefert `denied`. |
| SSH-Key | `~/.ssh/id_ed25519` | `ssh -o BatchMode=yes root@<ip> true` |
| Container-Images | GHCR | `ghcr.io/kainplanmusic/audiomonastry-ai-runtime:<tag>` + `master-player:v1.210.001` |
| Gewichte | R2 `weights/` | 21 TARs, 212 GB (Stand 2026-11-09) |
| Idle-Teardown | User-Cron auf Brain | `crontab -l \| grep idle-teardown` |

**Gewichte-Stand prüfen:**
```bash
set -a; source .env.deploy; set +a
.venv/bin/python scripts/weights-mirror.py            # Dry-Run: was fehlt?
```
Erwartung: „Alle Archive vorhanden" oder eine kurze Liste. Fehlende Archive
mit `--yes --only <rolle>` spiegeln (HF → Brain-Puffer → R2).

---

## 1. Preflight (kostet nichts)

```bash
cd /mnt/wd-elements/Medien/Projekte/audioMONASTRY
set -a; source .env.deploy; set +a

# 1a. Ist-Zustand: läuft schon etwas?
python3 scripts/fleet-start.py                 # Dry-Run Hetzner
python3 scripts/runpod-pods.py status          # Ist-Pods + Kosten

# 1b. Plan prüfen: VRAM, Budget, Modell-Zuordnung
python3 scripts/runpod-pods.py plan

# 1c. Tests
python3 tests/test_runpod_pods.py
python3 tests/test_weights_mirror.py
```

**Abbruchkriterien:**
- `plan` meldet `PROBLEM:` → erst fixen, nicht starten
- Budget > 6,00 €/h → erst prüfen
- Tests rot → erst fixen

---

## 2. Deploy starten (kostet ab jetzt)

### 2a. Alles in einem Rutsch (empfohlen)

```bash
bash scripts/deploy-full.sh 2>&1 | tee "deploy/logs/deploy-$(date +%Y%m%d-%H%M%S).log"
```

Das Skript macht:
1. Preflight (Plan + Tests)
2. Hetzner: 4 Rollen provisionieren + App deployen
3. RunPod: 8 Pods starten
4. Warten auf `/ready` aller Pods (max. 20 Min)
5. Smoke-Test je Pod
6. Ergebnis-Tabelle + Log-Pfad

### 2b. Manuell, Schritt für Schritt

```bash
# Hetzner (4 Rollen + App-Deploy)
python3 scripts/fleet-start.py --yes --no-pods

# RunPod-Pods
python3 scripts/runpod-pods.py up --yes

# Status + Ready-Check
python3 scripts/runpod-pods.py status
```

---

## 3. Verifikation (Pflicht, sonst kein „fertig")

### 3a. Hetzner

```bash
APP_IP=$(python3 -c "import sys; sys.path.insert(0,'scripts'); import fleet_start" 2>/dev/null || true)
ssh root@<app-ip> "curl -s http://localhost:8080/api/health"
```
Erwartung: `{"status":"ok", ...}`

### 3b. RunPod-Pods

```bash
python3 scripts/runpod-pods.py status
```
Erwartung: alle 8 Pods `RUNNING`, `ready=true`.

### 3c. Smoke-Test je Pod

```bash
python3 scripts/runpod-smoke.py            # sofern konfiguriert
```

### 3d. Kosten

```bash
python3 scripts/runpod-pods.py status | tail -3
```
Erwartung: `Summe: ~2,58 €/h` (alle always), Budget 6,00 €/h.

---

## 4. Betrieb

| Was | Wie |
|-----|-----|
| Logs Pod | `python3 scripts/runpod-pods.py logs <role>` |
| Logs App | `ssh root@<app-ip> journalctl -u audiomonastry -f` |
| Idle-Teardown | läuft automatisch (Cron alle 5 Min, 15 Min Idle → Snapshot → löschen) |
| Manuell stoppen | `python3 scripts/runpod-pods.py down --yes` + `python3 scripts/fleet-teardown.py --yes` |

---

## 5. Teardown (MUSS nach jeder Session)

```bash
# 1. Snapshots + RunPod-Pods löschen
python3 scripts/runpod-pods.py down --yes

# 2. Hetzner-Server löschen (mit Snapshot)
python3 scripts/fleet-teardown.py --yes

# 3. Prüfen: 0 Server, 0 Pods, 0 €
python3 scripts/fleet-start.py
python3 scripts/runpod-pods.py status
```

**Der Idle-Teardown macht das automatisch** — aber nur, wenn der Cron läuft:
```bash
crontab -l | grep idle-teardown
# */5 * * * * cd .../audioMONASTRY && python3 scripts/fleet-idle-teardown.py --apply >> ~/audiomonastry-idle-teardown.log 2>&1
```

---

## 6. Bekannte Fallstricke

| Problem | Ursache | Fix |
|---------|---------|-----|
| Pod `EXITED`, Log „unauthorized"/„denied" | Registry-Credential falsch | `RP_REGISTRY_AUTH_ID=cmvae16im0013wtg4cw2pbp3j` |
| Pod startet, `/ready` 404 | Modell lädt noch | warten (max. 10 Min), dann Logs prüfen |
| `qwen3-4b`-TAR 0 GB | abgebrochener Upload | `weights-mirror.py --yes --force --only brain` |
| audio-brain OOM | 45/45 GB (alte Config) | jetzt 28/42 GB (Music Flamingo auf song) |
| `directRepo`-Pod lädt langsam | HF statt R2 | für always-Pods `directRepo` entfernen |
| Hetzner-curl von lokal timeoutet | Firewall | über `ssh root@<ip> "curl localhost:8080/..."` |
| `costPerHr` fehlt | API v3 nutzt `cost` | `runpod-pods.py` ist gepatcht |

---

## 7. Zeit-Referenz (gemessen 2026-11-09)

| Schritt | Dauer |
|---------|-------|
| Hetzner provisionieren (4 Rollen) | ~3–5 Min |
| App-Deploy | ~4–6 Min |
| Image-Pull (parallel) | ~2–4 Min |
| Gewichte-Download (music, 61,5 GB @100 MB/s) | ~10 Min |
| Modell-Laden | ~2–3 Min |
| **Gesamt bis alles nutzbar** | **~15 Min** |

Engpass ist `music` (61,5 GB). Wenn RunPod schneller als 100 MB/s von R2
zieht (gleiche Region, oft 200+), sind es 8–10 Min.

---

## 8. Kosten-Kontrolle

| Posten | Preis |
|--------|-------|
| RunPod 8 Pods (always) | 2,58 €/h |
| Hetzner 4 Rollen | ~0,20 €/h |
| R2-Speicher (212 GB) | ~3,20 €/Monat |
| Hetzner-Snapshots | ~0,01 €/GB/Monat |

**Regel:** Kein Pod, kein Server läuft ohne Nutzung länger als 15 Min.
Der Idle-Teardown erzwingt das. Bei Zweifel: `runpod-pods.py down --yes`.
