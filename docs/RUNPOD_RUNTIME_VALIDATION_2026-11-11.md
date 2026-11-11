# Modellgewichte und echte Laufzeittests – Abschluss am 11. November 2026

## Ergebnis

Alle sechs beauftragten Befunde sind behoben. Sie betreffen sieben Modell-IDs: Mega 53, BVE, DeReverb, YuE2, UniverSR, Beat This! und Basic Pitch. Fünf davon haben echte GPU-Inferenz mit den gepinnten Originalgewichten bestanden; Beat This! und Basic Pitch haben echte CPU-Inferenz im gebauten Image bestanden. Alle acht Python-Runtime-Rollen lassen sich konfigurieren.

**Der Bestand beziehungsweise Bezugspfad für die 22 Modelle ist nachgewiesen. Eine Freigabe der vollständigen Acht-Pod-Flotte folgt daraus nicht:** Weitere Rollen-Abhängigkeiten und ein Mastering-Handler sind noch offen. Die Flotte wurde deshalb nicht als vollständig betriebsbereit markiert oder ausgerollt.

## Erledigte Befunde

| Befund | Umsetzung und praktischer Nachweis |
|---|---|
| Mega 53 und BVE fehlen im Stem-Dispatch | Gepinnte Configs/Checkpoints und `STEM_MODEL_SPECS` ergänzt. Echte GPU-Inferenz liefert fünf App-Stems aus 53 nativen Mega-Ausgängen sowie zwei BVE-Ausgänge. |
| DeReverb ohne SHA-Pins | Checkpoint- und Config-SHA im Loader gesetzt. Laden und GPU-Inferenz erfolgreich. Der erneute vollständige R2-Readback bestätigt die Bytes; fehlende SHA-Objektmetadaten wurden nicht als beschädigte Gewichte ausgelegt. |
| YuE2-VAE nicht separat erfasst | Eigener Manifest-/Lock-Bestand für `m-a-p/YuE2-Vae`, gepinnte Revision und Dateihashes, R2-Provisionierung. Echte YuE2-GPU-Generierung lädt diesen Bestand. |
| YuE2/UniverSR ohne Revision beim Laden | Revisionen an die Upstream-Loader übergeben; YuE2 erhält zusätzlich `vae_revision`. Beide echten GPU-Aufrufe erfolgreich. |
| Beat This! ohne garantierten lokalen Checkpoint | Atomare, SHA-geprüfte Bereitstellung unter `/data/weights/beat-this/final0.ckpt`; zusätzlich gepinntes Python-Paket installiert. Echter CPU-Adapterlauf auf 12 Sekunden Klicksignal liefert 25 Beat-Zeitpunkte. |
| Basic Pitch nur als CPU-Eintrag | Paket-Wheel und ONNX-Gewichte versionsfest gepinnt, im Image geprüft. Drei synthetische Töne ergeben drei MIDI-Noten und eine gültige MIDI-Datei mit 332 Bytes. |

## Zusätzlich während der echten Tests behobene Fehler

- Die Python-Rollenliste enthielt ausgemusterte Rollen. Sie entspricht jetzt den acht ausgewählten Runtime-Rollen.
- Der gepinnte MSST-Upstream erzwingt auf A40 FlashAttention, obwohl diese drei Checkpoints FP32 verwenden. Der erste GPU-Lauf scheiterte tatsächlich mit `No available kernel`. Für FP32 werden jetzt die geeigneten PyTorch-SDPA-Backends zugelassen; Originalgewichte bleiben unverändert. Die folgenden GPU-Läufe bestanden.
- Ein äußerer Runpod-Jobstatus `COMPLETED` genügte zuvor zur Erfolgsmeldung, obwohl die innere Inferenz einen Fehler zurückgab. Die Prüfung verlangt jetzt inneren Erfolg und nachgewiesenes CUDA; die Audioausgabe wird anschließend dekodiert und numerisch geprüft.
- YuE2 braucht ein eigenes Abhängigkeitsprofil (Torch 2.10/CUDA 12.8). Das Song-Pod-Profil verwendet jetzt standardmäßig das tatsächlich getestete unveränderliche YuE2-Image und setzt die CUDA-Untergrenze bei der Platzierung. `RP_SONG_IMAGE` bleibt als ausdrückliche Überschreibung möglich. Brain-/Vis-Image-Anforderungen bleiben verpflichtend.

## Echte Inferenz-Ergebnisse

Alle fünf GPU-Modelle liefen auf einer NVIDIA A40. Zeiten enthalten den Handler-Aufruf einschließlich gegebenenfalls Laden/Download, jedoch keine Warteschlange; es sind keine belastbaren Warmstart-Benchmarks.

| Modell | Ausgabebeleg | Handler-Zeit | gemessener Prozess-VRAM-Peak |
|---|---|---:|---:|
| mel-roformer-bve | 2 Stems; 4 s Stereo/44,1 kHz | 10.780 s | 4.505 GiB |
| mel-roformer-dereverb | 2 Stems; 4 s Stereo/44,1 kHz | 7.785 s | 5.059 GiB |
| mvsep-mega-53 | 5 App-Stems, 53 native Ausgänge; 4 s Stereo/44,1 kHz | 74.800 s | 6.095 GiB |
| universr | 16-kHz-Eingabe → 4 s Mono/48 kHz | 11.343 s | 1.554 GiB |
| yue2-3b | 10,238667 s Stereo/48 kHz, FLAC/24 Bit | 32.596 s | 6.861 GiB |

Die Prozess-Peaks können bereits zwischengespeicherte Modelle desselben Workers einschließen. Die drei Stem-Summen rekonstruieren das synthetische Eingangssignal mit RMS-Abweichung unter `3.4e-9`; sämtliche Ausgaben sind endlich und samplegenau ausgerichtet. Das bestätigt die Signal-/Dateiintegrität, nicht die musikalische Qualität der Trennung.

YuE2 wurde mit `planning=off`, 256 semantischen Tokens und selbst verfasster kurzer Textvorlage getestet. Die Ausgabe meldet erwartungsgemäß `truncated=true`; dies ist kein vollständiger Songtest. Zwei Samples liegen nahe Vollaussteuerung (Anteil etwa `2.03e-6`); die PCM-Datei enthält keine Werte außerhalb des darstellbaren Bereichs. Keine subjektive Hörbewertung oder Aussage über semantische Texttreue wurde erfunden. Die Tests verwenden synthetische beziehungsweise selbst formulierte Inhalte.

## Verfügbarkeitsabgleich aller 22 Modelle

Der vollständige Bestandsabgleich vom 10. November bleibt als historischer Snapshot erhalten. Die folgende Tabelle ergänzt die inzwischen erfolgreichen Laufzeittests. „Nicht ausgeführt“ bezeichnet einen fehlenden Inferenznachweis, keinen fehlenden Gewichtsbestand.

| Modell-ID | Pods/Rollen | Gewichtsbezug | Inferenz dieses Auftrags |
|---|---|---|---|
| qwen3-4b | audio-brain | R2-TAR, erforderliche Mitglieder geprüft | Nicht ausgeführt |
| qwen3-tts-voicedesign | voice | R2-Dateien | Nicht ausgeführt |
| acestep-v15-xl-base | voice | R2-Dateien | Nicht ausgeführt |
| acestep-5hz-lm-4b | music | R2-Dateien | Nicht ausgeführt |
| clap-music | ears | R2-Dateien | Nicht ausgeführt |
| qwen3-tts-17b | voice | R2-TAR, erforderliche Mitglieder geprüft | Nicht ausgeführt |
| acestep-v15-xl-turbo | music | R2-TAR, erforderliche Mitglieder geprüft | Nicht ausgeführt |
| songformer | ears | R2-Dateien | Nicht ausgeführt |
| beat-this | ears | R2-Zusatzbestand + gepinnter Upstream | CPU bestanden |
| acestep-v15-shared | voice, music | R2-Dateien | Nicht ausgeführt |
| moss-soundeffect-v2.0 | voice | R2-TAR, erforderliche Mitglieder geprüft | Nicht ausgeführt |
| bs-roformer-sw-6stem | studio | R2-Dateien | Nicht ausgeführt |
| mel-roformer-dereverb | vis | R2-Dateien | GPU bestanden |
| sonicmaster | studio | Gepinntes Upstream-Repository | Nicht ausgeführt |
| universr | vis | Gepinntes Upstream-Repository | GPU bestanden |
| yue2-3b | song | Gepinntes Upstream-Repository | GPU bestanden |
| qwen38-27b-fp8 | brain | Gepinntes Upstream-Repository | Nicht ausgeführt |
| moss-music-8b-instruct | ears | Gepinntes Upstream-Repository | Nicht ausgeführt |
| dsp-analysis | ears | Keine Gewichte (DSP) | Nicht ausgeführt |
| basic-pitch | ears | Gepinntes Paket/ONNX | CPU bestanden |
| mvsep-mega-53 | studio | R2-Zusatzbestand + gepinnter Upstream | GPU bestanden |
| mel-roformer-bve | studio | R2-Zusatzbestand + gepinnter Upstream | GPU bestanden |

15 Modell-IDs haben R2-Gewichte, fünf beziehen ihre Hauptgewichte direkt aus gepinnten Upstream-Repositories, Basic Pitch aus dem gepinnten Paket und DSP benötigt keine Gewichte. YuE2s zusätzliches VAE liegt separat auf R2. R2-Endbestand nach Ergänzungen: 703 Objekte, 344.948.252.580 Bytes; keine bestehenden Objekte gelöscht. 16 Zusatzdateien (3.806.757.088 Bytes) wurden vollständig per SHA geprüft. Die zehn großen Archive repräsentieren 92.792.524.800 Bytes; hier wurden TAR-Mitglieder, Größen, Links und Snapshot-Identität per Range geprüft, kein vollständiger 92-GB-Hashreadback.

## Noch offene Grenzen der vollständigen Flotte

Der historische Image-Audit (`RUNPOD_IMAGE_AUDIT_2026-11-10.json`) zeigte fehlende ACE-Step-Pakete für vier IDs, MOSS-SFX und vLLM sowie fehlenden SonicMaster-Mastering-Dispatch. Beat This!, UniverSR und YuE2 wurden seit diesem Audit gezielt nachinstalliert und tatsächlich ausgeführt. Die anderen dort genannten Lücken sind damit nicht automatisch behoben.

Zusätzlich brauchen Qwen3.5 und MOSS-Music passende Transformers-/Torch-Profile; die aktuell getesteten Audio-Images beweisen diese Rollen nicht. Das Brain-Image und das kombinierte Chromium/NVENC-/Audio-Vis-Image sind nicht vollständig validiert. Vis bleibt durch `RP_VIS_AI_IMAGE_READY` geschützt. Ein Dauerbetrieb aller 22 Modelle auf acht Rollen ist daher weiterhin **nicht freigegeben**.

## Images und reproduzierbare Nachweise

| Profil | Unveränderliches Image | Build / GPU-Lauf |
|---|---|---|
| Gemeinsames Audio mit FP32-Korrektur, Beat This!, Basic Pitch und UniverSR | `ghcr.io/kainplanmusic/audiomonastry-ai-runtime-runpod@sha256:fa3cc9c93a4e3bc869b182354a042893c5f8b7fe1c4eb982f70fdffc63910b07` | [Build 42931097792](https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/42931097792), [Stem-Test 42932440622](https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/42932440622), [UniverSR 42933996504](https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/42933996504) |
| YuE2, Torch 2.10/CUDA 12.8 | `ghcr.io/kainplanmusic/audiomonastry-ai-runtime-runpod@sha256:c24a10ec750a18c8e0ddcb8fe89064efc04dbb20c57e63817dbd22d2ab8d9854` | [Build 42932257215](https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/42932257215), [GPU-Test 42934570533](https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/42934570533) |

Die Bilder enthalten die erfolgreich getestete Inferenzimplementierung. Die anschließenden Änderungen betreffen Auswertung, Nachweisdokumente und die Pod-Image-Auswahl; dafür wurde kein identischer GPU-Lauf wiederholt.

38 gezielte Python-Regressionstests bestanden: 8 S3-Signierung, 5 Auth/Fleet-Probe, 10 R2-Manifest/Image-Auswahl, 4 Upload-Grenzen, 11 Gewichtsprovisionierung. Python-Kompilierung und `git diff --check` bestanden. Die bereits ausgeführten Gesamtsuiten bleiben wegen dokumentierter Baseline-Fehler rot; es wird keine vollständige grüne CI behauptet.

Numerische Nachweise liegen in `RUNPOD_STEMS_GPU_VALIDATION_2026-11-11.json`, `RUNPOD_UNIVERSR_GPU_VALIDATION_2026-11-11.json`, `RUNPOD_YUE2_GPU_VALIDATION_2026-11-11.json` und `RUNPOD_WEIGHT_CPU_SMOKE_2026-11-11.json`. R2-Zusatzprüfungen und Abschluss-Inventar liegen daneben. Das Auswerteskript verarbeitet die Actions-Artefakte ohne Vertrauen auf den äußeren Jobstatus.

## Kosten und Aufräumen

Alle drei erfolgreichen GPU-Batches wurden laufend gegen das Gesamtlimit von 8 EUR/h geprüft. Höchster konservativ geschätzter Gesamtwert: **4,407 EUR/h**, inklusive Steuer-/Wechselkursfaktor und Reserve. Das ist ein Stichprobenwert und keine abgerechnete Gesamtsumme. Die Rechnung zählte auch gemeldete wartende Worker konservativ mit.

Alle drei temporären Test-Endpunkte wurden gelöscht. Der abschließende authentifizierte API-v2-Abruf am 11. November 2026 um 01:00 UTC bestätigt **0 Pods, 0 Endpunkte, 0 aktive Worker**, laufende Compute-Kosten **0 USD/h**. Die ausgewiesenen 0,40 EUR/h sind ausschließlich konfigurierte Rechenreserve. Bestehende Registry-Zugangsdaten wurden wiederverwendet; keine neuen dauerhaften Registry-Zugangsdaten angelegt.
