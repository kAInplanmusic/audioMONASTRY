# Deploy-Bereitschaft audioMONASTRY (Stand 2026-11-02)

Dieses Dokument ist die Checkliste für den finalen Deploy. Alles hier genannte
ist verifiziert; was nicht verifiziert ist, steht ausdrücklich unter
„Nicht verifiziert".

## 1. Gewichte: vollständig in R2 (persistent)

Bucket `audiomonastrysamples`, Präfix `weights/<model>/<revision>.tar` plus
`.sha256`. Geprüft per `S3Target.head()` für jedes Modell der Flotte:
**20/20 vorhanden, 180,2 GB**.

| Pod | Modelle |
|-----|---------|
| brain | qwen3-30b-a3b-awq, qwen3-4b |
| ears | whisper-large-v3, clap-music, mert-v1-330m, qwen2-audio-7b, pyannote-diarization, ast-audioset |
| voice | qwen3-tts-17b, qwen3-tts-voicedesign, qwen3-tts-06b-base, moss-soundeffect-v2.0, acestep-v15-xl-base, acestep-v15-shared |
| stems | bs-roformer-sw-6stem, htdemucs-6s |
| music | acestep-v15-xl-sft, acestep-v15-xl-turbo, acestep-5hz-lm-4b |

Die Pods bekommen beim Start nur zeitlich begrenzte Presigned-URLs
(`AI_WEIGHTS_URLS`, TTL 6 h, `deploy/runpod/pod-fleet.json → weights.urlTtlSeconds`).

Neu spiegeln (nur bei Modell-/Revisionswechsel nötig):
```bash
set -a; . ./.env.deploy; set +a
python3 scripts/weights-mirror.py          # zeigt Lücken, kein Download
python3 scripts/weights-mirror.py --yes    # lädt HF → tar → R2
```
Hinweis: Über die lokale Leitung (~1,5 MB/s) dauert der volle Spiegel ~30 h.
Schneller geht es auf einem Rechner im Rechenzentrum (dort gemessen: 39 s
Download + ~11 min Upload für 7,5 GB). `pyannote/segmentation-3.0` ist gegatet –
der HF-Account muss die Bedingungen akzeptiert haben, sonst `GatedRepoError 403`.

## 2. Kosten-Grenze: technisch erzwungen

`scripts/runpod-pods.py` prüft **vor** jedem `POST /v1/pods`:

* `MAX_USD_PER_HOUR = 1.0` je Instanz
* `ALLOWED_GPU_IDS = NVIDIA GeForce RTX 4090 / RTX 5090 / NVIDIA A40`

Verstoß → `ConfigError`, kein HTTP-Aufruf. Zusätzlich wird nach dem Anlegen je
Instanz `costPerHr` geprüft; Überschreitung beendet die Flotte sofort
(`cmd_down`).

`deploy/runpod/pod-fleet.json` enthält nur noch zulässige Karten:
```json
"gpuPools": {
  "48gb": [{"id": "NVIDIA A40", "usdPerHour": 0.35}],
  "24gb-nvenc": [
    {"id": "NVIDIA GeForce RTX 4090", "usdPerHour": 0.34},
    {"id": "NVIDIA GeForce RTX 5090", "usdPerHour": 0.69}
  ]
}
```
`src/config/aiInfrastructure.ts → RUNPOD_48GB_USD_PER_HOUR.pod.A40 = 0.35`
(Live-Listenpreis 2026-11-02) hält Manifest, Fleet und TS-Konstanten gleich;
`tests/podFleetConfig.test.ts` erzwingt diese Gleichheit.

## 3. Konfiguration und Secrets

`.env.deploy` enthält: `RUNPOD_API_KEY`, `RP_API_KEY`, `HCLOUD_TOKEN`,
`RP_POD_IMAGE`, `RP_REGISTRY_AUTH_ID`, `AI_POD_TOKEN` (48 Zeichen),
`CFS3_ACCESS_KEY/SECRET_KEY/BUCKET/ENDPOINT`, `CFR2_ACCOUNT_ID`, `HF_TOKEN`,
`GHCR_USERNAME/PASSWORD`, `DOMAIN`, `DEPLOY_DOMAIN`, `APP_URL`,
`SIGNALING_ALLOWED_ORIGINS`, `TURN_URLS`, `SB_URL`, `RP_ENDPOINT_ID_*`.

Vor jedem Start prüfen:
```bash
python3 scripts/runpod-pods.py plan     # VRAM + Kosten je Pod, kein Netzaufruf
python3 scripts/runpod-pods.py weights  # alle Gewichte im Bucket?
```
`plan` muss ohne `PROBLEM:`-Zeilen enden.

## 4. Deploy-Reihenfolge

```bash
set -a; . ./.env.deploy; set +a
python3 scripts/runpod-pods.py plan
python3 scripts/runpod-pods.py weights
python3 scripts/runpod-pods.py up --yes --wait 900
```

`up` startet in `startOrder` (brain → ears → voice → stems → music), gibt je Pod
`RP_POD_ID_<ROLLE>=…` aus und wartet mit `--wait` auf `/ready` je Instanz.

Danach Server-/App-Seite:
1. `RP_POD_ID_*` in die Server-`.env` übernehmen.
2. App-Image bauen/pushen (`scripts/hetzner/registry-push.sh`) oder
   `deploy.sh` mit `DEPLOY_IMAGE_SOURCE=registry`, `DEPLOY_HOST`, `DEPLOY_DOMAIN`,
   `DEPLOY_SSH_KEY`.
3. Health: `curl -fsS https://<domain>/api/health`.
4. Smoke: `DEPLOY_SMOKE=1 ./deploy.sh`.

Beenden (Kosten stoppen):
```bash
python3 scripts/runpod-pods.py down --yes
```

## 5. Tests (Stand dieser Änderung)

| Suite | Ergebnis |
|-------|----------|
| `tests/podFleetConfig.test.ts`, `podRouting`, `podStartTriggers`, `aiResidentFleet` | 61/61 grün |
| `services/audiomonastry-ai-runtime/tests/test_vram_probe.py` | 16/16 grün, 3× stabil, 0,27 s |

Behobener Bug: `LoadSampler.run()` konnte ohne Fortschritt drehen, wenn die
Clock einen großen Offset hat und `target − elapsed` unter 1 ULP fällt
(Float-Addition verschluckt den Schlafbetrag). Fix: `MIN_SLEEP_S = 1e-3` als
Mindestschritt. `stop_load()` joint den Sampler-Thread jetzt, bevor es die
Referenz leert — sonst sieht der nächste Start ein fremdes Fenster.

## 6. Nicht verifiziert

* **Pod-Start mit echten R2-Gewichten** auf einer GPU: Am 2026-11-02 nicht
  bestätigt. Zwei H200-Instanzen (Verstoß gegen die Kostengrenze, inzwischen
  gesperrt) antworteten nach 8 min nicht — `pod_start.py` lädt in dieser Zeit
  25 GB und entpackt sie. A6000/A40/L40 waren nicht verfügbar
  (`no instances currently available`).
  Beim ersten Deploy also `--wait 900` einplanen und `/ready` beobachten.
* **App-E2E mit 4 Test-Accounts, Xonar-U7-Hardwaretest**: offen.
