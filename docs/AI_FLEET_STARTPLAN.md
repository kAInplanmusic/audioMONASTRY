# AI-Flotte – Konfiguration und Startbedingungen

Abgleich: 2026-11-13 UTC. Aktueller Produktionsbestand ausschließlich in
[SERVER_FLEET.md](SERVER_FLEET.md). Kein Start und keine Infrastrukturänderung
wurde im Rahmen dieses Abgleichs ausgeführt.

## Konfigurationsquellen

- `deploy/gpu-provider.json`: Provider `vast`, globale Regionssuche, 8 EUR/h
  Gesamtgrenze ohne Hetzner/Supabase, höchstens 28 Minuten Testlauf,
  Runtime-Übernahme erst nach Readiness.
- `deploy/gpu/pod-fleet.json`: Rollen und Modellzuordnung.
- `services/audiomonastry-ai-runtime/model_manifest.json`: Modellidentitäten.
- `scripts/gpu-pods.py`: aktiver Provider-Dispatcher. Die frühere RunPod-
  Starttabelle mit festen Immer-an-Triggern ist keine aktuelle Spezifikation.

Die Dateien beschreiben Konfiguration, keine nachgewiesene Produktion. Der
Planer kann Provider-Abfragen ausführen und lokalen Controller-State schreiben;
sein Aufruf ist keine rein lokale Live-Inventur.

## Vor einer gesondert autorisierten Inbetriebnahme

Gewichte, gepinnte Images, frische Angebote, vollständige Kosten einschließlich
Transfer sowie Secrets prüfen. Private Runtime-Adressen erst nach
authentifizierter Readiness und exaktem geladenem Modellinventar übernehmen;
anschließend echte Inferenz mit normalen Handler-Defaults und den separaten
Chromium/NVENC-Nachweis prüfen. Ein Containerstatus genügt nicht.

Der datierte Migrations-/Testverlauf steht in
[VAST_MIGRATION_STATUS_2026-11-11.md](VAST_MIGRATION_STATUS_2026-11-11.md);
Betriebskonzept und historische Bereinigungen in
[VAST_ON_DEMAND_BETRIEB_2026-11-12.md](VAST_ON_DEMAND_BETRIEB_2026-11-12.md).
Frühere Buchungen und Cleanup-Meldungen belegen keinen heutigen Accountbestand.


# Runde4 – historische8/7/22 und konkrete Bestätigungsvorlage (2026-11-13)
Keine Provisionierung. Belege `R4-P3-*`. Historische vollständige Matrix: `475f5c63712e0a2b7259f0b7bdce9a75e06e7822`. Acht Rollen-SSOT in0ad9ffd,22 zugewiesene eindeutige Einträge in603a27f, bereinigtes22er-Manifest ohne alte Generatoren in5d85488, sieben immutable Digestbindungen in475f5c6, providerneutraler Pfad ineb672f9. Die heutige Rollen-/Modell-/Revisionsbelegung stimmt damit überein. Keine künstlichen Ersatzmodelle nötig.
**Zählung:**8 Instanzen,7 logische native Zielimages,22 eindeutige Manifest-IDs,23 Rollenladungen. ACEshared wird in voice/music geladen und nur einmal gezählt. dsp-analysis ist ein CPU-DSP-Paket ohne neuronalen Checkpoint; BasicPitch ist CPU-ONNX. Das sind ausdrücklich nicht22 GPU-Checkpoints.
## Acht Slots zur Bestätigung

| Instanz | Rolle | Zielimage | Exakte Manifest-IDs | FLUX/Wan / Ersatz |
|---|---|---|---|---|
| 1 | brain | I1 | `qwen38-27b-fp8` | nicht betroffen; kein Ersatz |
| 2 | ears | I2 | `moss-music-8b-instruct`, `clap-music`, `beat-this`, `songformer`, `dsp-analysis`, `basic-pitch` | nicht betroffen; kein Ersatz |
| 3 | voice | I3 | `qwen3-tts-17b`, `qwen3-tts-voicedesign`, `moss-soundeffect-v2.0`, `acestep-v15-xl-base`, `acestep-v15-shared` | nicht betroffen; kein Ersatz |
| 4 | music | I3 | `acestep-v15-xl-turbo`, `acestep-5hz-lm-4b`, `acestep-v15-shared` | nicht betroffen; kein Ersatz |
| 5 | studio | I4 | `sonicmaster`, `bs-roformer-sw-6stem`, `mvsep-mega-53`, `mel-roformer-bve` | nicht betroffen; kein Ersatz |
| 6 | audio-brain | I5 | `qwen3-4b` | nicht betroffen; kein Ersatz |
| 7 | song | I6 | `yue2-3b` | nicht betroffen; kein Ersatz |
| 8 | vis | I7 | `universr`, `mel-roformer-dereverb` | nicht betroffen; kein Ersatz; beide IDs sind AUDIO, Renderer-Servicebindung ungeprüft |

## Sieben native Zielimages und historische Herkunft

**Diese Zielidentitäten sind geplant, nicht gebaut oder als pullbar attestiert.** Native Output-Digests sind unbekannt. Tagform: `ghcr.io/kainplanmusic/audiomonastry-ai-runtime-vast:<role>-f551f689d55a0564052928be41b971f5d5a2f575`, bestehende Recipe `services/audiomonastry-ai-runtime/Dockerfile.vast`. Die folgenden historischen Digests sind ausschließlich Herkunft/aktuelle Buildinputs, **keine startfreigegebenen nativen Images**. Opake Inhalte wurden nicht inspiziert; besonders I7 ist nicht aufgrund seines Namens als generatorfrei oder als laufender Renderer bewiesen. M2 bleibt offen. Unzulässige alte Inhalte verlangen sauberen nativen Neubau, keine Wiederherstellung von FLUX/Wan.

| Image | Rollen | geplantes natives Tag-Suffix | historischer Basis-Digest |
|---|---|---|---|
| I1 | brain | `brain-f551f689d55a0564052928be41b971f5d5a2f575` | `sha256:a6250cbcca6e2b0a8c1d054664d77dc79890ce625ab943b5950625a349e56fbd` |
| I2 | ears | `ears-f551f689d55a0564052928be41b971f5d5a2f575` | `sha256:59d39cdf86c3c0c18e58169a46f3bdd569c546ea28afa4d5444704ffa2bc0703` |
| I3 | voice, music | `voice-f551f689d55a0564052928be41b971f5d5a2f575` | `sha256:af5c29843a962150469632bfdc6efc035539d3cd88cf53b7776fa6144adbff4b` |
| I4 | studio | `studio-f551f689d55a0564052928be41b971f5d5a2f575` | `sha256:e6824ff420bf73574236c51ed2ec946ec332737a2a5881ac03c61afd2ddb330e` |
| I5 | audio-brain | `audio-brain-f551f689d55a0564052928be41b971f5d5a2f575` | `sha256:be8316d6b572a303839420914d0b0dbdc119fd81debf2dd397097634cfa4dff8` |
| I6 | song | `song-f551f689d55a0564052928be41b971f5d5a2f575` | `sha256:40f724c3648b1b3528cb330ff86a6b65c6f8389b51b0da55f88af1bc05e3132b` |
| I7 | vis | `vis-f551f689d55a0564052928be41b971f5d5a2f575` | `sha256:bb500964583d7e0e793316205831553a6b8625c4396d8ae5447866c6c9734a19` |

Slot8 heißt historisch vis, aber UniversR erledigt Audio-Upsampling und mel-roformer-dereverb Audio-DeReverb. Der Drei-Dateien-Check (`R4-P3-VIS-RENDERER-BOUNDARY`) liefert keinen laufenden Produktionsrenderer: vast_start delegiert den Supervisor; vast_app bietet eine Renderdiagnose, kein attestiertes dauerhaftes Renderer-Servicebinding. Genau ein vorhandene-Medien-Renderer bleibt Betreiberziel; eine Modellliste allein beweist dessen Start nicht.

## Entfernte Legacy-Slots bleiben entfernt

| Frühere Metadatenrolle | entfernte IDs / Funktion | Ersatzvorschlag |
|---|---|---|
| imageHq | flux1-dev | keiner; kein Bildgenerator |
| videoReal | wan22-t2v-a14b | keiner; kein Videogenerator |
| videoAbstract | ltx-video-13b | keiner; kein Videogenerator |
| Trainingsstarter | ausgemusterter Workflow, kein zusätzlicher Modell-/Instanzslot | keiner |

Diese Legacy-Rollen gehören nicht zur bereits bereinigten8/7/22-Matrix. Kein Platzhalter, keine Wiederbelegung.

## Exakte22 Identitäten und Revisionen

| ID | Repository | Revision | Rolle(n) |
|---|---|---|---|
| `acestep-5hz-lm-4b` | `ACE-Step/acestep-5Hz-lm-4B` | `0a3ec94b557aea7d508da38b31cfe7341f6ff737` | music |
| `acestep-v15-shared` | `ACE-Step/Ace-Step1.5` | `19671f406d603126926c1b7e2adc169acbcade22` | voice, music |
| `acestep-v15-xl-base` | `ACE-Step/acestep-v15-xl-base` | `220c1166efbdd9583eafcb12eb160594bbfcb241` | voice |
| `acestep-v15-xl-turbo` | `ACE-Step/acestep-v15-xl-turbo` | `d4a0b288b83ebb7e25a8c0b32c573c22e134e8ee` | music |
| `basic-pitch` | `spotify/basic-pitch` | `9991303bba609a3b93089d13ec80d1d495083596` | ears |
| `beat-this` | `CPJKU/beat_this` | `ad7974846029835307ba19a3d5cefbf40b243041` | ears |
| `bs-roformer-sw-6stem` | `FractalSurfer/BS-RoFormer-SW-6stem` | `2b98254b19bdab07ce225d884ec4aa9dd8aafce1` | studio |
| `clap-music` | `laion/larger_clap_music` | `a0b4534a14f58e20944452dff00a22a06ce629d1` | ears |
| `dsp-analysis` | `libAudioFlux/audioFlux` | `cpu-only` | ears |
| `mel-roformer-bve` | `Gonzaluigi/Mel-Band-Roformer-BVE-Gonzaluigi` | `c73a679a87e568133b7e7387f58c9d3186a51ad4` | studio |
| `mel-roformer-dereverb` | `anvuew/dereverb_mel_band_roformer` | `cef05ad2b5b3145ea5c149d3ad5d1f8439b34d06` | vis |
| `moss-music-8b-instruct` | `OpenMOSS-Team/MOSS-Music-8B-Instruct` | `fce7f8304e96cc2d3398b8106456cbb2ecec3139` | ears |
| `moss-soundeffect-v2.0` | `OpenMOSS-Team/MOSS-SoundEffect-v2.0` | `e35df4d82fbe87fcd5d14e5d100e349c0c3c076d` | voice |
| `mvsep-mega-53` | `ZFTurbo/Music-Source-Separation-Training` | `ea7eb9c20ea0e3f94368a30fc1654b51cdd55789` | studio |
| `qwen3-4b` | `Qwen/Qwen3.5-4B` | `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a` | audio-brain |
| `qwen3-tts-17b` | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | `0c0e3051f131929182e2c023b9537f8b1c68adfe` | voice |
| `qwen3-tts-voicedesign` | `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | `5ecdb67327fd37bb2e042aab12ff7391903235d3` | voice |
| `qwen38-27b-fp8` | `Qwen/Qwen3.8-27B-FP8` | `017b9c7af6b5689d5dd426a76e0bc077eb5ca20a` | brain |
| `songformer` | `ASLP-lab/SongFormer` | `a75880ed1b7375ac71860ec6c4fc9c899cf99515` | ears |
| `sonicmaster` | `amaai-lab/SonicMaster` | `93c7fa73c4dd446c9e656af34524b5f6a416afda` | studio |
| `universr` | `woongzip1/universr-audio` | `1c3294844285af851b6ffa56cbde4e43cd41fc2b` | vis |
| `yue2-3b` | `m-a-p/YuE2-3B` | `8f24312f187763b9854adeec87e437e2b03bbff1` | song |

**Bestätigungsfrage:** Diese22 Modelle/Manifest-Einträge in diesen7 geplanten nativen Images auf diesen8 Instanzen – bestätigen? Die Bestätigung gilt für diese konkrete Belegung einschließlich des offengelegten CPU-DSP-Eintrags, nicht als Beleg bereits verfügbarer Image-Digests oder geschlossener M2-Prüfung. Vor Provisionierung sind native Artefakte/Inhalte, Modellidentitäten, Angebote und Kosten zu prüfen. Nichts provisioniert.

**Getrennte Spur:** B3 braucht nach aktueller Betreiberanweisung Hetzner/SFU und Netzwerk-B1, keine Vast-GPUs; diese Modell-/Imagebestätigung ist keine B3-Startbedingung.

Konkreter vorgeschlagener Build-Quellstand dieser Bestätigung: `f551f689d55a0564052928be41b971f5d5a2f575` (Runde3, native Runtime-/Manifestdateien in Runde4 unverändert). Die sieben oben genannten Tag-Namen sind geplante Ausgabeartefakte dieses Quellstands, keine existierenden oder inhaltsgeprüften Digests. Repositories/Revisionen sind Git-Sollwerte; Verfügbarkeit der Remote-Gewichte und Inferenz werden damit nicht behauptet.
