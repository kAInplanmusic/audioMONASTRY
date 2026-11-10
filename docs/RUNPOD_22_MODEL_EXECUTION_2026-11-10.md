# RunPod 22/22 — tatsächliche Abnahme / Blocker (2026-11-10)

**SSOT:** [RUNPOD_FLEET_SSOT.md](RUNPOD_FLEET_SSOT.md), `deploy/runpod/pod-fleet.json`, `services/audiomonastry-ai-runtime/model_manifest.json`.

**Status: NOT PRODUCTION-READY.** 22/22 manifestierte Modell-/Tool-IDs; **0/18 echte GPU-Inferenzen durch diesen Auditlauf bestätigt**; **0/2 CPU-Inferenzen dieses Auditlaufs bestätigt**; **0/2 ACE-Step-Abhängigkeiten live bewiesen**. **0 Pods angelegt oder gelöscht.** Kein authentifizierter RunPod-Konto- oder R2-Datenzugriff in dieser Sitzung. Tests/Handler im Code sind *keine* echten GPU-Nachweise.

## Durchgeführte Codekorrekturen in PR #26

1. Acht kanonische Runtime-Rollen statt historischer image/video/orchestrator Serverless-Namen; Python-/TypeScript-/JSON-Rollenübersichten.
2. `audio.master` -> `handlers_sonicmaster.sonicmaster_master` über offizielles `infer_single.py` von SonicMaster. Installation von `/opt/sonicmaster` und GPU-Kompatibilität ausstehend.
3. `mvsep-mega-53`: BSRoformer-MSST-Spezifikation, eigene 53-Stem-Ausgabe (nicht auf fünf heruntergerechnet), für lange Audiojobs genau 53 presigned R2-PUT-URLs, für isolierte Smoke-Proben <=1 Sekunde begrenzte Inline-Ausgabe.
4. MVSEP GitHub Release v1.0.21: exakte `sha256:c62820893bbf86d4e734f966bd142d9157cfc8bb8e79e9d8f9ea553f3ff3519f` des 1.37-GB-Checkpoints und `sha256:7e198062a251587088adb91215a4f44ab59e67bd62fcc805cf54d6e7dfc51103` der YAML-Datei. Release ist veränderbar, einzelne Byte-Hashes sind deshalb zwingend. `weights-mirror.py` baut ein Offline-R2-TAR mit `extras/mvsep-mega-53/`.
5. `mel-roformer-bve`: echter BVE-Lead/Back-Adapter und publizierter Checkpoint-Digest. **Upstream-Pins nun gelöst:** Voll-SHA `c73a679a87e568133b7e7387f58c9d3186a51ad4`, YAML SHA256 `2b88a4421fbba171f829254a7097b8e085a5f67c472aa1ddaef76108fd8e68fa` via GitHub Actions; R2-Byteintegrität und CUDA noch offen. Keine Revision/Prüfsumme geraten.
6. `mel-roformer-dereverb`: direkter noreverb/reverb-Adapter, veröffentlichter Checkpoint-Digest. **Upstream-Konfigurations-Pin gelöst:** YAML SHA256 `66963a9d60756076506a230b4e503c553a3beb7b4e9a10e6bcc73dee9dbd4866` via GitHub Actions; GPU-Messung weiterhin offen. Das Modell ist kein fünfspuriger Separator.
7. `weights-mirror.py`: stem.separate-Checkpoints `*.ckpt` werden nicht länger fälschlich ausgeschlossen. Auch der achte `visPod` wird in der Mirror-Schleife geprüft.
8. `/ready` im Resident-Modus ist fail-closed. `startup_model_proof.py` fordert reale CUDA-Verfügbarkeit, operator-kontrollierte `AI_MODEL_PROOF_FIXTURE`, passende Task-/Model-IDs und eine echte inhaltliche Inferenz jedes direkt ausführbaren Modells. Ein bloßer `ModelManager._loaded`-Eintrag oder VRAM-Schätzwert reicht nicht. Ohne Test-Fixtures bleibt die Runtime bewusst `503`.
9. Falsche RunPod-ID im Autostop-Test korrigiert, historische Serverless-vs-Pod-Vergleiche gegen aktuelle Pod-JSON-SSOT ersetzt.
10. Audio-Flow-CI unterscheidet ausschließlich die erwartete optionale `503 /api/library` (keine Supabase/R2-Credentials im test runner) von echten Browser-/HTTP-Fehlern; übrige 4xx/5xx oder Page Errors bleiben fatal.

## Einträge und erforderliche Testarten

| Pod | Manifest-ID | Testart | Offener Beleg |
|---|---|---|---|
| brain | qwen38-27b-fp8 | GPU direkt | vLLM FP8, echtes LLM-Resultat, CUDA + peak VRAM |
| ears | moss-music-8b-instruct | GPU direkt | Remote-Code-/Loader-Audit, beschreibendes Resultat |
| ears | clap-music | GPU direkt | Text/Audio-Embedding, Finite/Dims |
| ears | beat-this | GPU direkt | Beat-Timestamps/BPM aus Test-WAV |
| ears | songformer | GPU direkt | Songstruktur, Remote-Code-/Lizenzprüfung |
| ears | dsp-analysis | CPU direkt | reale Kennzahlen |
| ears | basic-pitch | CPU direkt | valide MIDI-Bytes `MThd` |
| voice | qwen3-tts-17b | GPU direkt | echte Sprache/WAV |
| voice | qwen3-tts-voicedesign | GPU direkt | VoiceDesign-Audio |
| voice | moss-soundeffect-v2.0 | GPU direkt | SFX-WAV, Audio-QA |
| voice | acestep-v15-xl-base | GPU direkt | Kontext/LEGO Audio + Shared-Komponenten |
| voice/music | acestep-v15-shared | abhängiges Asset | VAE-/Encoder-Dateien und echte Nutzung im ACE-Step-Pfad |
| music | acestep-v15-xl-turbo | GPU direkt | Generate/Remix, Output |
| music | acestep-5hz-lm-4b | abhängiges Asset | nachweislich verwendete Planung/LM im Turbo-Pfad |
| studio | sonicmaster | GPU direkt | Upstream-Skript/Image, VAE, Audio-Master-Resultat |
| studio | bs-roformer-sw-6stem | GPU direkt | sechs passende Stems, Checkpoint-/Lizenzen |
| studio | mvsep-mega-53 | GPU direkt | echte MSST-Kompatibilität, 53 Output-Stems, Release-Digests und R2 |
| studio | mel-roformer-bve | GPU direkt, unverified | R2-Integrität, Loader/GPU |
| audio-brain | qwen3-4b | GPU direkt | JSON-Commands, Auth/Locks, keine direkte Ausführung |
| song | yue2-3b | GPU direkt | WAV/FLAC, kommerzielle Lizenzklärung (NC) |
| vis | universr | GPU direkt | validiertes Upsampling-Ergebnis |
| vis | mel-roformer-dereverb | GPU direkt, unverified | R2-Integrität, Loader/GPU |

## Exakte weitere Gates bis 22/22

1. **Upstream Provenance:** BVE-Voll-SHA und beide YAML-SHA256 am 10.11.2026 durch erfolgreichen öffentlichen GitHub-Actions-Job bestätigt und in SSOT/Loader übertragen. Noch offen sind unveränderliche Container-Digests und Prüfung aller 22 Lizenz-/Dependencies.
2. **R2-Datenprüfung**: authenticated `python3 scripts/weights-mirror.py` und `python3 scripts/runpod-pods.py weights`; sämtliche tatsächlich benötigten Dateien byteweise hashen, nicht nur HEAD-Existenz. Der Spiegel ist bislang nicht live ausgeführt.
3. **Container-Builds**: GitHub-SHA, Torch/CUDA-Versionen, msst-Pin, `/opt/sonicmaster/infer_single.py`, ACE-Step 5Hz-LM, BVE YAML sowie 53-Stem-Config in den per Rolle verwendeten Images prüfen. Keine ungeprüften Remote-Code-Loader oder ungepinnten pip-Dependencies.
4. **Operator-Probe-Fixtures**: für jeden realen Modell-Aufruf pro Rolle eine synthetische oder lizenzfreie Audio-/Textprobe und erwartete Ausgabefelder in `AI_MODEL_PROOF_FIXTURE` bereitstellen (lokal, nicht Git). Der Generator-/Image-Stagingpfad ist **noch nicht** vollständig implementiert. Ohne ihn bleibt `/ready=503` (gewollte Sicherheitsgrenze).
5. **Echte Inferenz & Qualität**: jeden Pod isoliert auf der vorgesehenen echten RunPod-GPU starten, Modell warm laden, echte Probe, Latenz/CUDA/VRAM-Peak erfassen, Ausgabe dekodieren und hören. CPU-Basic Pitch/DSP ebenso mit echter Inputdatei testen. Dependencies als integrierten Pipeline-Nachweis prüfen.
6. **Cleanup & Kosten**: nur die vom Test erzeugte Pod-ID löschen, danach Provider-Inventar überprüfen; Account-Watchdog und 8-EUR/h-Fleetgrenze. Keine Produktions-Pods oder Volumes löschen. `finally` allein ist bei Runner-SIGKILL unzureichend.
7. **DAW-Integration / vier Nutzer**: ein echter Auftrag pro relevantem MONK-Plugin, R2-Ausgaben, auth, Locks, Cancel/Retry, Real-Time AudioThread bleibt unaffected, vier simultane Nutzer, Hörprüfung.
8. **CI**: auf exakt demselben Release-Commit müssen Mandatory Verify, AI, Build, Audio Flow, Deep Audit 300 und SonarCloud komplett bestanden sein. Keine CI-Abnahme aus Zwischencommits.

**Aktuelle reale Einschränkung:** GitHub-Konnektor ist aktiv und der Branch enthält die Codeänderungen. RunPod-Control-Plane, echte GPU-Pods und R2-Buckets können über die aktuell verfügbaren Werkzeuge nicht authentifiziert gelesen/gesteuert werden. Es gab daher keine produktive Änderung und keinen billable GPU-Start. Freigabe bleibt **RED**.

## Reproduzierbare statische Prüfung (nicht GPU)

```bash
python3 scripts/runpod-ssot-preflight.py --json
python3 tests/test_runpod_ssot_preflight.py
python3 tests/test_runpod_model_contracts.py
python3 services/audiomonastry-ai-runtime/tests/test_startup_model_proof.py
python3 scripts/audit-runpod-model-contracts.py # exit 4 bis alle Blocker gelöst
```

## Fortsetzung: R2-/Startup-/CI-Implementierung

- `scripts/weights-mirror.py` berücksichtigt nun **alle acht Pods einschließlich `vis`** und behält für Stem-Modelle `*.ckpt`; vormals konnte ein scheinbar erfolgreicher Spiegel ohne wesentlichen RoFormer-Checkpoint entstehen.
- `directRepo` für GPU-Gewichte aufgehoben (Brain/MOSS/YuE/SonicMaster/Beat This/MVSEP/BVE/UniverSR), da der Pod mit `HF_HUB_OFFLINE=1` läuft. Echte Gewichts-Downloads sind **noch nicht erfolgt**, die vollständigen Archive müssen erst vorhanden und byteverifiziert werden.
- Für Beat This wird der separat veröffentlichte `final0.ckpt` mit festem Pin `ad797484…`, erwarteten 81.058.141 Bytes und SHA256 `8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331` vor dem R2-Upload geprüft und unter `HF_HOME/extras/beat-this` geladen.
- `scripts/runpod-r2-readonly-audit.py` prüft alle 22 IDs, meldet CPU-Tools und ungültige Revisionen und berücksichtigt TAR-/Edge-Manifeste. Dieser Test ist nur **Metadateninventur**, kein SHA256-Beweis des tatsächlichen R2-Datenstroms.
- `scripts/resolve-runpod-upstream-pins.py` und der Workflow `.github/workflows/runpod-upstream-provenance.yml` für BVE/DeReverb-Konfigurations-Digests sind angelegt, aber **kein erfolgreicher Upstream-Abgleich dieses Workflows wurde bisher gesichtet**.
- Historische Serverless-vs-Pod-Assertions sind in `tests/test_runpod_deploy_defaults.py` durch echte JSON-SSOT-Assertions ersetzt; die historischen Serverless-Sicherheits- und Template-Tests bleiben getrennt.
- Letzter vollständig ausgewerteter Pflicht-CI-Lauf auf `ed53ca57`: **433/433 Vitest-Dateien grün**, Python-Smoke schlug fehl (historische Manifest/GPU-Tests). Seither Korrekturen gepusht; **neuster Head noch nicht durch vollständig grünen CI-Lauf belegt**.
- Audio-Flow-Job wurde gezielt für nur eine in CI bekannte optionale `503 /api/library` angepasst. Alle anderen Browser- und HTTP-Fehler bleiben rot; neue CI-Abnahme steht aus.
- Kein RunPod GPU gestartet, keine fremden Pods gestoppt, keine Produktionskonfiguration oder Secrets geschrieben.

**Nicht als Erfolg interpretieren:** Die Architektur ist technisch weiter vorbereitet, aber 18 GPU-Live-Inferenztests, 2 CPU-Live-Analysejobs, 2 echte ACE-Step-Integrationsbelege, R2-Byteprüfung und die vier gleichzeitigen DAW-Nutzer fehlen weiterhin. Der neue fail-closed `/ready`-Check benötigt eine sichere, pro Pod ausgestattete Operator-Probe-Fixture, deren Produktion/Deployment noch aussteht.

## Follow-up: Offline-Pod-Bootstrap-/Container-/Checkpoint-Fixes

Folgende GitHub-Codeänderungen wurden nach obigem initialen Protokoll auf demselben Arbeitsbranch umgesetzt:

- **Kein falscher Offline-Fallback:** Alle tatsächlich GPU-bezogenen `directRepo`-Flags wurden im aktuellen `model_manifest.json` auf `false` gestellt. Nur zwei CPU-Pakete behalten das Flag; `pod_start.py` ignoriert deren `directRepo` für die HF-Offline-Entscheidung. Somit soll die Runtime nicht mehr heimlich den HF-Netzzugriff einschalten.
- **Beat This:** `weights-mirror.py` lädt `final0.ckpt` von der offiziell in `handlers_ears.py` hinterlegten Quelle, prüft **81.058.141 Byte** und die konfigurierte komplette SHA256 vor dem R2-Upload. Loader sucht die entpackte Datei unter `HF_HOME/extras/beat-this/`.
- **Docker-Verkabelung:** Beide Runtime-Dockerfiles kopieren nun die neuen Dateien `handlers_sonicmaster.py` und `startup_model_proof.py`. Das RunPod-Pod-Image startet `pod_start.py` (HTTP-/ready-/runsync-Runtime), nicht mehr `runpod_worker.py` (historischer Serverless-Eventloop). **Containerbau und tatsächlicher HTTP-Start noch nicht gemessen.**
- **SonicMaster:** Optionaler Build-Arg `AI_INSTALL_SONICMASTER` installiert den geprüften Upstream-Source-Commit `ab32b2d456e461b6bbc188d666caf2eabefa2f31`, ohne das alte `requirements_sonic.txt` mit inkompatiblen Torch-/Transformers-Downgrades ungeprüft einzuspielen. Build-Importtest vorhanden, tatsächliche CUDA-Inferenz weiterhin ausstehend.
- **CI:** Pflicht-CI enthält jetzt Python-`py_compile` für die neuen Runtime-/Provenance-/Mirror-Skripte. Der Audio-Flow-Workflow erlaubt nur die nachweislich optionale, schlüssellose `503 /api/library`; andere Requests oder JavaScript-Ausnahmen bleiben Fehler.
- **Provenance-Workflow:** `.github/workflows/runpod-upstream-provenance.yml` ruft `scripts/resolve-runpod-upstream-pins.py` auf. Da bislang kein erfolgreiches Workflow-Artefakt der neuen Branchversion sichtbar ist, bleiben BVE-Full-SHA und beide Konfigurations-Hashes unverifiziert.
- **R2:** `scripts/runpod-r2-readonly-audit.py` kann den Objekt-/Sidecar-Inventarstand auslesen, behauptet aber **keine Byte-Integrität**. Dazu müssen die tatsächlichen Checkpoints vom Pod geladen und gehasht werden.

**Zu beachten:** Der Docker-Start kann wegen fehlender `AI_MODEL_PROOF_FIXTURE`, unvollständiger Upstream-Abhängigkeiten oder nicht synchronisierten R2-Gewichten absichtlich blockiert werden. Das ist ein echter noch offener Deployment-Blocker, keine grüne Readiness.

**Neuster Nachweis der GitHub-CI:** Der letzte ausgewertete alte Lauf auf `ed53ca57` zeigte 433/433 bestandene Vitest-Dateien und danach eine fehlgeschlagene Python-Phase; die entsprechenden historischen Serverless/POD-Tests wurden später korrigiert. **Für die jüngsten Commits wurde noch kein vollständig grüner Actions-Lauf beobachtet.** Kein GPU-Smoke durch dieses Protokoll durchgeführt.

## Abnahme-Fortschritt: verifizierte BVE- und DeReverb-Revisionen

- **Upstream verifiziert:** Workflow `RunPod public upstream provenance (no GPU/secrets)`, GitHub Actions Run `42855793336`, erfolgreich.
- **BVE:** `c73a679a87e568133b7e7387f58c9d3186a51ad4`, Config `sha256:2b88a4421fbba171f829254a7097b8e085a5f67c472aa1ddaef76108fd8e68fa`, Checkpoint-LFS-Metadaten gegen `e003bbb97ebef78c59cd6b46c5fc3d0f2303cd49f6fb98eb8b8f0f8075899ae3` bestätigt.
- **DeReverb:** `cef05ad2b5b3145ea5c149d3ad5d1f8439b34d06`, Config `sha256:66963a9d60756076506a230b4e503c553a3beb7b4e9a10e6bcc73dee9dbd4866`, Checkpoint-Metadaten gegen `9262877b87e9ebb0fb808a456b0a411fa677f5df31c8383c1254af531c078970` bestätigt.
- Manifest, `handlers_stems.py` und statische Regressionstests entsprechend aktualisiert. **Damit sind die beiden PIN-Blocker beseitigt.** Der reale R2-/GPU-Status bleibt unbekannt; weiterhin keine 22/22-Inferenzfreigabe.
- **Weitere CI-Korrektur:** Legacy-Phi-Modelltest auf aktiven FP8-Brain migriert, explizites `trustRemoteCode=false` für Brain gesetzt; Audio-Flow optionaler Library-503-RegEx repariert.

## Image-Dependencies und ACE-Step-Fix — Nachtrag

- **Verpackungsfehler gefunden und korrigiert:** `handlers_fleet2026.py` fehlte in beiden gemeinsamen Dockerfiles; nun wird die Datei mit den aktiven Qwen/MOSS/YuE/UniverSR-Adaptern eingebaut.
- **Song-Pod isoliert:** `services/audiomonastry-ai-runtime/Dockerfile.song` nutzt `pytorch/pytorch:2.10.0-cuda12.8-cudnn9-runtime` und YuE2/transformers 4.57.6. Das aktuelle Song-Modell benötigt damit nicht länger den inkompatiblen Torch-2.8-Shared-Container. Der echte Image-Build ist weiter nicht nachgewiesen. `deploy/runpod/pod-fleet.json` verlangt `RP_SONG_IMAGE` für diese Rolle.
- **Vis-Pod:** Dockerfile.runpod bietet optionalen Upstream-Code-Install mit exakt gepinntem `woongzip1/UniverSR`-Commit `d8636623fe0c0704296239c1d3d3c5b911ecb2e0`, ohne den globalen PyTorch-Build zu überschreiben. Installations- und CUDA-Probe bleiben offen.
- **Music-Pod:** `handlers_runpod.acestep_generate` nutzt nun `handlers_voice.run_acestep`, also die offizielle ACE-Step-1.5-`AceStepHandler`/`generate_music`-API. Der vorherige unpassende generische `DiffusionPipeline.from_pretrained`-Aufruf wurde entfernt. Regressionstest hinzugefügt.
- **Nicht als bestandene Audioqualität oder GPU-Inferenz werten.** Entscheidend bleiben acht echte Einzelpod-Starts auf Zielhardware, erfolgreiches Entpacken der kompletten R2-Gewichte, der CUDA-Warmup pro Modell, gültige Audio-Artefakte und Cleanup.

### Nachgewiesene CI-Zwischenergebnisse

Auf einem Zwischencommit `cefc7d4d` wurden `Audio Flow`, `ai` und `Deep Audit 300` durch GitHub Actions erfolgreich abgeschlossen; der öffentliche Upstream-Provenance-Workflow ist wiederholt grün. Der vollständige Pflicht-CI-/Build-/Sonar-Abschluss für den aktuellen HEAD ist noch nicht nachgewiesen. **Es gibt weiterhin keinerlei Beleg dafür, dass 18/18 GPU-Inferenzen erfolgreich liefen.**
