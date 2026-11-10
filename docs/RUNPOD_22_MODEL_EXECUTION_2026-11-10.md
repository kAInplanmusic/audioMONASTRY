# RunPod 22/22 — tatsächliche Abnahme / Blocker (2026-11-10)

**SSOT:** [RUNPOD_FLEET_SSOT.md](RUNPOD_FLEET_SSOT.md), `deploy/runpod/pod-fleet.json`, `services/audiomonastry-ai-runtime/model_manifest.json`.

**Status: NOT PRODUCTION-READY.** 22/22 manifestierte Modell-/Tool-IDs; **0/18 echte GPU-Inferenzen durch diesen Auditlauf bestätigt**; **0/2 CPU-Inferenzen dieses Auditlaufs bestätigt**; **0/2 ACE-Step-Abhängigkeiten live bewiesen**. **0 Pods angelegt oder gelöscht.** Kein authentifizierter RunPod-Konto- oder R2-Datenzugriff in dieser Sitzung. Tests/Handler im Code sind *keine* echten GPU-Nachweise.

## Durchgeführte Codekorrekturen in PR #26

1. Acht kanonische Runtime-Rollen statt historischer image/video/orchestrator Serverless-Namen; Python-/TypeScript-/JSON-Rollenübersichten.
2. `audio.master` -> `handlers_sonicmaster.sonicmaster_master` über offizielles `infer_single.py` von SonicMaster. Installation von `/opt/sonicmaster` und GPU-Kompatibilität ausstehend.
3. `mvsep-mega-53`: BSRoformer-MSST-Spezifikation, eigene 53-Stem-Ausgabe (nicht auf fünf heruntergerechnet), für lange Audiojobs genau 53 presigned R2-PUT-URLs, für isolierte Smoke-Proben <=1 Sekunde begrenzte Inline-Ausgabe.
4. MVSEP GitHub Release v1.0.21: exakte `sha256:c62820893bbf86d4e734f966bd142d9157cfc8bb8e79e9d8f9ea553f3ff3519f` des 1.37-GB-Checkpoints und `sha256:7e198062a251587088adb91215a4f44ab59e67bd62fcc805cf54d6e7dfc51103` der YAML-Datei. Release ist veränderbar, einzelne Byte-Hashes sind deshalb zwingend. `weights-mirror.py` baut ein Offline-R2-TAR mit `extras/mvsep-mega-53/`.
5. `mel-roformer-bve`: echter BVE-Lead/Back-Adapter und publizierter Checkpoint-Digest. **Weiter blockiert** durch verkürzte HF-Revision `c73a679` und fehlende YAML-SHA256. Keine Revision/Prüfsumme geraten.
6. `mel-roformer-dereverb`: direkter noreverb/reverb-Adapter, veröffentlichter Checkpoint-Digest. **Weiter blockiert** durch fehlende YAML-SHA256, außerdem keine GPU-Messung. Das Modell ist kein fünfspuriger Separator.
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
| studio | mel-roformer-bve | GPU direkt, derzeit BLOCKED | voller HF-Commit, YAML-Hash, Adapter/GPU |
| audio-brain | qwen3-4b | GPU direkt | JSON-Commands, Auth/Locks, keine direkte Ausführung |
| song | yue2-3b | GPU direkt | WAV/FLAC, kommerzielle Lizenzklärung (NC) |
| vis | universr | GPU direkt | validiertes Upsampling-Ergebnis |
| vis | mel-roformer-dereverb | GPU direkt, derzeit BLOCKED | YAML-Hash, unabhängiger Pair-Job |

## Exakte weitere Gates bis 22/22

1. **Upstream Provenance**: vollständige BVE-Commit-SHA via HF API (nicht erraten); SHA256 der BVE- und DeReverb-YAML, unveränderliche Container-Digests; Prüfung aller 22 Lizenz-/Dependencies.
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
