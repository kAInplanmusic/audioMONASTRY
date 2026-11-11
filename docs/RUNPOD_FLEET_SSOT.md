# RunPod SSOT — 2026-11-10

**EINZIGE aktive GPU- und Gewichtszuordnung:** [pod-fleet.json](../deploy/gpu/pod-fleet.json) + [model_manifest.json](../services/audiomonastry-ai-runtime/model_manifest.json). Genau acht Rollen, KEINE weiteren aktiven Modelle. **HARTES GESAMTBUDGET 8,00 EUR/h**, inklusive konfigurierter Steuerannahme und Puffer, **kein Preislimit je Pod**. Angaben sind Planungswerte, keine Live-GPU-Validierung.

| Pod | GPU (Priorität) | Modelle und Tools | Modell+Runtime GB | GPU GB | Sicherheitsabstand GB |
|---|---|---|---:|---:|---:|
| brain | NVIDIA RTX 6000 Ada → NVIDIA L40S → NVIDIA L40 | `qwen38-27b-fp8` | 41 | 48 | 6 |
| ears | NVIDIA RTX 6000 Ada → NVIDIA L40S → NVIDIA L40 | `moss-music-8b-instruct`, `clap-music`, `beat-this`, `songformer`, `dsp-analysis`, `basic-pitch` | 36 | 48 | 6 |
| voice | NVIDIA A40 → NVIDIA RTX A6000 → NVIDIA L40 | `qwen3-tts-17b`, `qwen3-tts-voicedesign`, `moss-soundeffect-v2.0`, `acestep-v15-xl-base`, `acestep-v15-shared` | 39 | 48 | 6 |
| music | NVIDIA RTX 6000 Ada → NVIDIA L40S → NVIDIA L40 | `acestep-v15-xl-turbo`, `acestep-5hz-lm-4b`, `acestep-v15-shared` | 27 | 48 | 6 |
| studio | NVIDIA RTX PRO 6000 Blackwell Server Edition → NVIDIA RTX PRO 6000 Blackwell Max-Q | `sonicmaster`, `bs-roformer-sw-6stem`, `mvsep-mega-53`, `mel-roformer-bve` | 61 | 96 | 8 |
| audio-brain | NVIDIA GeForce RTX 5090 → NVIDIA GeForce RTX 4090 | `qwen3-4b` | 14 | 32 | 5 |
| song | NVIDIA GeForce RTX 5090 → NVIDIA GeForce RTX 4090 | `yue2-3b` | 18 | 32 | 5 |
| vis | NVIDIA A40 → NVIDIA RTX A6000 → NVIDIA L40 | `universr`, `mel-roformer-dereverb` | 21 | 48 | 6 |

**Kostenplan:** 5.99 USD GPU/h, **6.96 EUR/h** inklusive Budget-USt.-Faktor und Nebenkostenpuffer. Live-Angebotspreis und Verfügbarkeit vor jeder Pod-Erstellung prüfen; bei Abweichung Gesamtbudget neu evaluieren. Die Gewichte selbst sind nicht hier gelagert, sondern kommen aus gepinnten Upstream-Repositories / bestehendem R2-Mirror.

## Aktive Gewichte und Revisionen

### brain

- **qwen38-27b-fp8**: `Qwen/Qwen3.8-27B-FP8@017b9c7af6b5689d5dd426a76e0bc077eb5ca20a` · fp8 · 37 GB angesetzt · Task `llm`.

### ears

- **moss-music-8b-instruct**: `OpenMOSS-Team/MOSS-Music-8B-Instruct@fce7f8304e96cc2d3398b8106456cbb2ecec3139` · bf16 · 26 GB angesetzt · Task `understand`.
- **clap-music**: `laion/larger_clap_music@a0b4534a14f58e20944452dff00a22a06ce629d1` · fp16 · 4 GB angesetzt · Task `embed`.
- **beat-this**: `CPJKU/beat_this@ad7974846029835307ba19a3d5cefbf40b243041` · fp32 · 1 GB angesetzt · Task `audio.analyze`.
- **songformer**: `ASLP-lab/SongFormer@a75880ed1b7375ac71860ec6c4fc9c899cf99515` · bf16 · 3 GB angesetzt · Task `audio.analyze`.
- **dsp-analysis**: `libAudioFlux/audioFlux@cpu-only` · fp32 · 0 GB angesetzt · Task `analyze`.
- **basic-pitch**: `spotify/basic-pitch@9991303bba609a3b93089d13ec80d1d495083596` · fp32 · 0 GB angesetzt · Task `analyze`.

### voice

- **qwen3-tts-17b**: `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice@0c0e3051f131929182e2c023b9537f8b1c68adfe` · bf16 · 8 GB angesetzt · Task `tts`.
- **qwen3-tts-voicedesign**: `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign@5ecdb67327fd37bb2e042aab12ff7391903235d3` · bf16 · 8 GB angesetzt · Task `tts`.
- **moss-soundeffect-v2.0**: `OpenMOSS-Team/MOSS-SoundEffect-v2.0@e35df4d82fbe87fcd5d14e5d100e349c0c3c076d` · bf16 · 8 GB angesetzt · Task `generate`.
- **acestep-v15-xl-base**: `ACE-Step/acestep-v15-xl-base@220c1166efbdd9583eafcb12eb160594bbfcb241` · bf16 · 10 GB angesetzt · Task `song`.
- **acestep-v15-shared**: `ACE-Step/Ace-Step1.5@19671f406d603126926c1b7e2adc169acbcade22` · bf16 · 2 GB angesetzt · Task `song`.

### music

- **acestep-v15-xl-turbo**: `ACE-Step/acestep-v15-xl-turbo@d4a0b288b83ebb7e25a8c0b32c573c22e134e8ee` · bf16 · 10 GB angesetzt · Task `song`.
- **acestep-5hz-lm-4b**: `ACE-Step/acestep-5Hz-lm-4B@0a3ec94b557aea7d508da38b31cfe7341f6ff737` · bf16 · 9 GB angesetzt · Task `song`.
- **acestep-v15-shared**: `ACE-Step/Ace-Step1.5@19671f406d603126926c1b7e2adc169acbcade22` · bf16 · 2 GB angesetzt · Task `song`.

### studio

- **sonicmaster**: `amaai-lab/SonicMaster@93c7fa73c4dd446c9e656af34524b5f6a416afda` · fp16 · 8 GB angesetzt · Task `audio.master`.
- **bs-roformer-sw-6stem**: `FractalSurfer/BS-RoFormer-SW-6stem@2b98254b19bdab07ce225d884ec4aa9dd8aafce1` · bf16 · 6 GB angesetzt · Task `stem.separate`.
- **mvsep-mega-53**: `ZFTurbo/Music-Source-Separation-Training@ea7eb9c20ea0e3f94368a30fc1654b51cdd55789` · fp32 · 32 GB angesetzt · Task `stem.separate`.
- **mel-roformer-bve**: `Gonzaluigi/Mel-Band-Roformer-BVE-Gonzaluigi@c73a679a87e568133b7e7387f58c9d3186a51ad4` · fp32 · 3 GB angesetzt · Task `stem.separate`.

### audio-brain

- **qwen3-4b**: `Qwen/Qwen3.5-4B@851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a` · bf16 · 11 GB angesetzt · Task `gui.execute`.

### song

- **yue2-3b**: `m-a-p/YuE2-3B@8f24312f187763b9854adeec87e437e2b03bbff1` · bf16 · 15 GB angesetzt · Task `song`.

### vis

- **universr**: `woongzip1/universr-audio@1c3294844285af851b6ffa56cbde4e43cd41fc2b` · fp16 · 4 GB angesetzt · Task `audio.upsample`.
- **mel-roformer-dereverb**: `anvuew/dereverb_mel_band_roformer@cef05ad2b5b3145ea5c149d3ad5d1f8439b34d06` · fp32 · 3 GB angesetzt · Task `stem.separate`.

## Verifikationsgates

Gewichte, Dependency-Versionen, Loader und Checkpoint-Hashes vor Start pruefen. Besonders MVSep Mega 53 (VRAM bislang Schaetzung), BVE (voller HF-Pin, GPU-Lauf noch offen), MOSS-Music (Custom Code) und A08 (NVENC + Restaurierung) sind **nicht GPU-verifiziert**. Einzelplugin-Joblock != globale GPU-Gleichzeitigkeit. GPU-Peak, CPU-RAM, Ausgabeformat, Tonqualitaet, Latenz und Max-Kosten mit echten Jobs pruefen. Entfernte Registry-Eintraege sind **keine Loeschung bestehender R2-Archive oder RunPod-Volumes**.


## Gepinnte Zusatzgewichte (2026-11-10)

`services/audiomonastry-ai-runtime/weight_assets.lock.json` pinnt Checkpoints,
Configs, Dateigroessen und SHA-256 fuer Mega 53, BVE, DeReverb, Beat This!,
Basic Pitch und den separaten YuE2-VAE. Es bleiben 22 aktive Modell-IDs;
`weightComponents.yue2-vae` ist eine Abhaengigkeit von `yue2-3b`.
Der Pod-Start prueft die Zusatzgewichte vor dem Start der Runtime;
HTTP- und Serverless-Readiness pruefen sie ebenfalls vor dem Preload.
DeReverb verwendet jetzt den gepinnten direkten Download und erfordert kein
altes R2-TAR mehr. Basic Pitch nutzt den hash-gepinnten 0.4.0-Wheel mit ONNX
auf CPU. Das Build-Gate prueft seinen gebuendelten ONNX-Hash.

Die vollstaendige Umsetzung, echte Download-/CPU-Belege und offene
Produktionsgates stehen in [MODEL_WEIGHT_PROVISIONING_2026-11-10.md](MODEL_WEIGHT_PROVISIONING_2026-11-10.md).


## R2-Live-Abgleich

Der direkte S3-Zugriff auf `audiomonastrysamples` wurde mit HTTP 200 bestaetigt.
Der Erstbestand umfasst 685 Gewichtsobjekte mit 342.054.600.915 Bytes.
`requiredWeightFiles` im Modellmanifest verhindert, dass ein unvollstaendiger
Einzeldatei-Spiegel ein vorhandenes TAR verdeckt. Die Identitaet des Spiegel-
Manifests und die Groessen aller erforderlichen Gewichtsdateien muessen passen.
R2-Zusatzgewichte werden als kurzlebige Presigned-Downloads mit festen Hashes
an die Pods uebergeben; R2-Schluessel werden dabei nicht in die Pods kopiert.
Details: [R2_MODEL_AVAILABILITY_2026-11-10.md](R2_MODEL_AVAILABILITY_2026-11-10.md).
