# RunPod Betrieb — Acht-Pod-SSOT (10.11.2026)

**Verbindlich:** [RUNPOD_FLEET_SSOT.md](RUNPOD_FLEET_SSOT.md) und ausschließlich [pod-fleet.json](../deploy/runpod/pod-fleet.json) + [model_manifest.json](../services/audiomonastry-ai-runtime/model_manifest.json).

Die aktive GPU-Flotte umfasst genau acht Pods: `brain`, `ears`, `voice`, `music`, `studio`, `audio-brain`, `song`, `vis`. Ihre NVIDIA-GPUs sind **heterogen** (32/48/96 GB je primärer Konfiguration). Weder „8×A40“ noch alte Serverless-Rollen beschreiben diese Flotte.

**Hartes GPU-Flottenbudget:** 8,00 EUR/h für alle gleichzeitig laufenden RunPod-Instanzen, inklusive des konfigurierten Steuerfaktors und Puffers. Die geplanten Preise sind keine verbindlichen Live-Angebote. Alle acht Rollen sind im JSON auf `startTrigger=always` gestellt; dies ist eine Konfiguration und kein Beweis, dass Pods laufen oder Modelle geladen sind.

## Read-only Vorprüfung

```bash
python3 scripts/runpod-ssot-preflight.py --json
python3 tests/test_runpod_ssot_preflight.py
python3 tests/test_resolve_bve_revision.py
python3 scripts/runpod-pods.py plan
python3 scripts/runpod-pods.py weights
python3 scripts/runpod-pods.py status --json
```

`weights` benötigt separate Cloudflare-R2-Zugangsdaten auf dem ausführenden Host. Ohne Zugriff auf R2 ist die Gewichtsprüfung **nicht bestanden**, sondern **nicht durchgeführt**.

## Sicherheits-/Verifikationsgate

- Vor jeglichem Kostenstart muss `mel-roformer-bve` den vollständigen verifizierten upstream Commit statt Kurz-SHA `c73a679` besitzen: `python3 scripts/resolve-bve-revision.py --apply`.
- Alle aktiven Modelle müssen im R2-Objektbestand und mit überprüften Checksum-Dateien vorhanden sein.
- Checkpoint-Loader, CUDA, Torch, VRAM und Lizenzfragen müssen je Rolle tatsächlich geprüft werden.
- `RP_API_KEY`/ `AI_POD_TOKEN` und R2-Zugang gehören ausschließlich in Secret-Management oder lokale ignorierte Umgebungsdateien. **Keine Zugangsdaten ins Git-Repository und keine Secrets in CI-Logs.**
- Vor Live-Starts RunPod-GPU-Verfügbarkeit, konkrete GPU-ID, Quote und Gesamtbudget über die API verifizieren. Der statische Preisplan ist keine Live-Quote.
- Das alte Workflow `.github/workflows/runpod-deploy.yml` und `scripts/runpod-deploy.py` sind **Legacy Serverless** und kein acht-Pod-Deploypfad. Nicht starten.

## Kostenpflichtiger Pod-Start (erst nach Freigabe aller Gates)

```bash
python3 scripts/runpod-pods.py up --yes --only brain --wait 900
python3 scripts/runpod-pods.py status --json
```

Für isolierte Prüfungen ist `scripts/runpod-live-verify.py` vorgesehen. Es versucht nur **neu angelegte** Test-Pods zu löschen und kontrolliert anschließend die Providerliste. Eine sichere Kostenkontrolle erfordert zusätzlich einen unabhängigen RunPod-Watchdog: Prozessabsturz, SIGKILL oder Provider-Ausfall können Cleanup verhindern.

**Niemals für einen einzelnen Smoke-Test `down --yes` ausführen**, denn dieser Befehl beendet sämtliche zum Flottenpräfix gehörenden Pods, auch bereits vorhandene.

## Evidenz

Aussagen wie „GPU verifiziert“, „R2 22/22“, „CI grün“ oder „produktionsreif“ dürfen erst nach dokumentierten echten Laufnachweisen ausgesprochen werden. Siehe [RUNPOD_LIVE_VERIFICATION_AUDIT_2026-11-10.md](RUNPOD_LIVE_VERIFICATION_AUDIT_2026-11-10.md).
