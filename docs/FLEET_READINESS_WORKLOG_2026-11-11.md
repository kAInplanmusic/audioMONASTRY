# Acht Rollen betriebsbereit machen – laufende Implementierung

Dieser Nachtrag erweitert den abgeschlossenen Sechs-Befunde-Auftrag. Noch keine Freigabe der vollständigen Flotte.

## Zusätzlich behobene Aufruf- und Startfehler

- Qwen3.5 Executor: native multimodale Transformers-Klasse statt falschem CausalLM-Autoload. Echter A40-Test bestanden: `transport.setTempo` mit `bpm=120`, ausschließlich vorgeschlagen und nicht ausgeführt. 26,171 s Handler-Zeit einschließlich Modellladen; Peak 9.264.609.280 Bytes. Run 42967346554, Image `sha256:1b5ec11acd59d8e1c273ebec5e4f15f9cf38b5968372f7cd84f253bf5a720549`.
- ACE-Step Textgenerierung: tatsächlicher AceStepHandler/generate_music-Aufruf statt generischer Diffusers-Pipeline. Separater Planner- und Shared-Asset-Pfad.
- MOSS-Music: dynamisch aufgelöste, gepinnte Klasse; Upstream bietet keinen AutoModel-Eintrag.
- SongFormer: privates Source-Staging für entfernten Transformers-Deepspeed-Import; HF-Cache-Blobs bleiben unverändert.
- Pod-Start: ausdrücklicher Start von pod_start.py/HTTP-App statt Serverless-Worker.
- Readiness: wirkliche Start-Inferenz; leere beziehungsweise nicht endliche Audiodaten blockieren die Bereitschaft. Fehlerhafte Loader geben ihr VRAM-Budget wieder frei.
- Deployment-Budget: Live-Angebot und ganze Kontobelegung einschließlich Serverless statt ausschließlich eigener Pod-Namen.
- SonicMaster: persistenter isolierter Prozess, eigener gepinnter Upstream-Code, zusätzliche T5-/VAE-Revisionen. Geschützter VAE-Abruf mit vorhandenem HF-Zugang erfolgreich geprüft. GPU-Inferenz noch nicht bestanden.

## Builds

Voice/Music, Ears und Executor wurden erfolgreich mit den neuen Abhängigkeiten gebaut. Die letzten Laufzeitkorrekturen werden als kleine Images auf diese unveränderlichen Abhängigkeits-Images gelegt. Song- und Vis-Build ebenfalls erfolgreich; Brain und SonicMaster benötigen korrigierte Builds und echte GPU-Prüfung.

Der erste Brain-Build scheiterte am fehlenden `python`-Alias. Das Runpod-SDK 1.12 kollidiert zusätzlich mit vLLMs FastAPI-Version; der Brain-Stack verwendet deshalb SDK 1.10 und FastAPI 0.136.0. Der erste SonicMaster-Build deckte einen NumPy/PyArrow-Konflikt auf; PyArrow 17 wurde gepinnt. Fehlgeschlagene Builds sind ausdrücklich kein Laufzeitnachweis.

Die übrigen GPU-Prüfungen laufen schrittweise mit begrenzten, anschließend gelöschten Ressourcen. Der frühere Nachweis für sieben Modelle bleibt gültig; ein vollständiger Betrieb aller 22 Einträge auf acht Pods ist weiterhin ausstehend.

## Weiterer tatsächlicher GPU-Befund

Run 42968099721: Qwen3-TTS CustomVoice und VoiceDesign erfolgreich auf A40; MOSS-SFX konnte Modellgewichte laden, scheiterte aber in Triton/Inductor an `/home/audiomonastry` (nicht schreibbar). Eigene Cache-Verzeichnisse und Compiler-Voraussetzungen sind ergänzt, erneuter Lauf ausstehend. Damit sind einschließlich der sieben ursprünglichen Modelle zehn Einträge tatsächlich ausgeführt. Die JSON-Datei `RUNPOD_VOICE_FIRST_GPU_VALIDATION_2026-11-11.json` hält den gemischten Erfolg ausdrücklich mit `passed=false` fest.

Alle Abhängigkeitsprofile sind inzwischen gebaut. Für Studio wird zusätzlich auf CUDA-12.8-Wheels umgestellt und `sm_120` im Build geprüft: Die ausgewählte 96-GB-Blackwell-GPU ist mit dem bisherigen CUDA-12.6-Image nicht abgesichert. Der Brain-Build mit SDK 1.10/FastAPI 0.136.0 besteht.

TypeScript-Typecheck und ESLint bestehen erneut. Ears-CPU-Modelle werden jetzt explizit vorgeladen, damit `residentOnly` sie nicht als ungeladen ablehnt. Fünf neue Readiness-/Rollback-Regressionstests bestehen.
