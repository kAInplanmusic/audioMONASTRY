# RunPod Phase 1 + 2 — Implementierungsnachweis (2026-11-10)

## Verbindliche Quellen

- `deploy/gpu/pod-fleet.json` — genau acht aktive Rollen, GPU-Prioritäten und hartes Flottenbudget **8 EUR/h**
- `services/audiomonastry-ai-runtime/model_manifest.json` — Modell-IDs, Repositories, Revisionen, Tasks, Loader-/Framework-Metadaten
- `docs/RUNPOD_FLEET_SSOT.md` — menschlich lesbare Entscheidungsgrundlage

Ältere Fünf-Pod- oder A40-only-Deploypläne sind **historisch**, keine Alternative.

## Phase 1 — umgesetzt auf Feature-Branch

1. `scripts/runpod-ssot-preflight.py`: offline ausführbarer, read-only Fail-Closed-Validator für Rollen, Modellreferenzen, GPU-Priorität, VRAM-Schätzung und 8-EUR/h-Budget.
2. `scripts/runpod-pods.py`: `plan`, `weights` und `up` sind durch den Validator geschützt. Die Gewichtsprüfung berücksichtigt jetzt ausdrücklich auch `vis`.
3. `scripts/runpod-deploy.py`: Legacy-Serverless-Entrypoint für ausführbare CLI-Aufrufe blockiert; historische Funktionen bleiben lesbar.
4. `tests/podFleetConfig.test.ts`: alte A40-only-/Music-Flamingo-Annahmen durch SSOT-konforme Rollen-/Budget-/VRAM-Vertragstests ersetzt.
5. `tests/test_runpod_ssot_preflight.py`: negative Regressionstests (Rollen-/Budgetdrift, fehlendes Modell, OOM-Fallback, Kurz-Revision).

## Phase 2 — geprüfte statische Fakten

- **8 Rollen**: brain, ears, voice, music, studio, audio-brain, song, vis.
- **22 eindeutige aktive Modell-IDs**: alle im Manifest vorhanden.
- Alle acht `aiRole`-Zuordnungen und ausgewählten Primär-GPU-IDs stimmen zwischen Fleet und Manifest überein.
- GPU-Memory-Zahlen sind **Planannahmen**, keine gemessenen Peaks.
- Offener **hart blockierender** Befund: `mel-roformer-bve` besitzt im Manifest nur die Kurz-Revision `c73a679`; ohne upstream-validierte volle Commit-ID erfolgt keine automatische Ergänzung.
- Beim `songformer` und `moss-music-8b-instruct` ist `trustRemoteCode` gesetzt. Vor Ausführung müssen fremder Code, Build-Container und genaue Abhängigkeiten überprüft werden.
- Dependency-Listen enthalten teils nur unversionierte Paketnamen; ein reproduzierbarer, für alle Modelle nachgewiesener Lock ist noch nicht belegt.
- Checkpoint-Dateihashes, R2-Objekte, GPU-Lader, CUDA-Versionen, Latenzen, Qualität und parallele Inferenz **wurden hier nicht live verifiziert**.

### Warum die Revision nicht erraten wird

Die HF-Weboberfläche zeigt für BVE einen signierten Commit mit Prefix `c73a679` und den Checkpoint `mel_band_roformer_bve_gonza.ckpt`. Ein Prefix ist keine vollständige unveränderliche 40-stellige Commit-ID. `--yes` darf deshalb kein Deployment an diesem Gate vorbei erzwingen.

## Reproduzierbare Befehle

```bash
python3 scripts/runpod-ssot-preflight.py --json
python3 -m unittest tests/test_runpod_ssot_preflight.py
npx vitest run tests/podFleetConfig.test.ts
# Erst nach Behebung aller BLOCKED SSOT Befunde:
python3 scripts/runpod-pods.py plan
python3 scripts/runpod-pods.py weights   # R2 Credentials erforderlich
# `up` ist kostenpflichtig: nicht ohne operative Freigabe starten.
```

## Release-Gates (noch offen)

| Gate | Status | Erforderlicher Nachweis |
|---|---|---|
| SSOT statische Konsistenz | Teilweise | volle BVE-Revision und grüne Regressionstests |
| Upstream Revisionen | Nicht abgeschlossen | API-verifizierte Commit-SHAs für jedes Modell |
| Checkpoint Integrität | Nicht abgeschlossen | SHA-256 pro Binärdatei, revisionsgebundene Manifestdatei |
| Dependency-/Image Lock | Nicht abgeschlossen | Container-Digests und reproduzierbare Builds |
| Loader Smoke | Nicht abgeschlossen | realer Modellstart/Inference pro Rolle |
| GPU VRAM & CUDA | Nicht abgeschlossen | Peak-VRAM-Messung inkl. KV-Cache und Batch |
| R2 | Nicht abgeschlossen | 22/22 Modellreferenzen nach Rollenzuordnung prüfen (Duplikate berücksichtigen) |
| Audio-Qualität | Nicht abgeschlossen | echte WAV/Stem/TTS/Restoration-Ausgabe hörbar und messbar |
| Produktions-Deploy | Nicht gestartet | separate autorisierte RunPod-Session mit Kostenüberwachung |

## Sicherheitsregeln

- Keine Produktions-Pods, Volumes, R2-Dateien oder existierenden Deployments löschen.
- Keine Schlüssel in Git committen.
- Alle potenziell kostenpflichtigen RunPod-Starts bleiben unter `--yes` + live überprüftem Budget.
- Ein grüner statischer Test **ist kein** grüner GPU- oder E2E-Test.
