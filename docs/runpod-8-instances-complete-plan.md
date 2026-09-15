# RunPod 8-Instanzen-Architektur – Gesamtplan

Stand: 2026-09-15
Status: 7 von 8 Instanzen live (Scale-to-Zero), Code/Config vollständig; Orchestrator offen
Kosten: 8 × A6000 48 GB × ~0,40 €/h = ~3,20 €/h Vollast | ~32 €/Monat bei 10 h Einsatz
Alles scale-to-zero (workersMin=0), 0 € wenn nicht genutzt.

---

## Umsetzungsstand 2026-09-15 (live)

| # | Rolle | Endpoint | Endpoint-ID | Bildquelle | Status |
|---|-------|----------|-------------|-----------|--------|
| 1 | brain | `samplemonk-ai-brain` | `ppxo7wrn599p0q` | RunPod-vLLM-Worker | live (vorhanden) |
| 2 | ears | `samplemonk-ai-ears` | `xeax6xrgd0csag` | eigenes Image `:8roles-v2` | live, Warmup verifiziert (7 Modelle) |
| 3 | voiceGen | `samplemonk-ai-voice` | `gajmangfldpzrk` | eigenes Image `:8roles-v2` | live |
| 4 | music | `samplemonk-ai-music` | `vsbjhw0nnnb47e` | Hub: ACE-Step 1.5 XL (ComfyUI) | live (neu) |
| 5 | imageHq | `samplemonk-ai-image` | `wzh9hcbitjnn95` | PrunaAI FLUX-Worker (umbenannt aus `vision`) | live |
| 6 | videoReal | `samplemonk-ai-video-real` | `6ghy4fh00zb0j9` | Wan-Worker (umbenannt aus `video`) | live |
| 7 | videoAbstract | `samplemonk-ai-video-abstract` | `fogwdyxp1zj8zv` | Hub: offizieller ComfyUI-Worker | live (neu) |
| 8 | orchestrator | `samplemonk-ai-orchestrator` | – | eigenes Image + MoA-Handler | **offen** (Handler fehlt) |

Verifiziert: `ears` mit einem echten `warmup`-Job (COMPLETED, Rolle `ears`,
3 Modelle geladen; die uebrigen Rollen-Modelle brauchen Audio als Input).

**Wichtig**: Die visuellen Rollen (imageHq/videoReal/videoAbstract) und music laufen
auf **vorgefertigten ComfyUI-/Hub-Workern**. Diese sprechen die ComfyUI-Workflow-API,
NICHT unser `{task, model, input}`-Protokoll. Der Orchestrator bindet sie deshalb als
MCP-Werkzeuge an und muss die Aufrufe uebersetzen (Adapter-Schicht, offen).

### Befund 2026-09-15: Image-Drift (Crash-Loop) – behoben per Gate

Das auf ears/voice deployte Image war vom 2026-09-10 und enthielt noch die
**alte** `model_manager.py`, die `quantization: "awq-int4"` (Rolle ears →
`qwen2-audio-7b` im neuen Manifest) nicht kannte. Ein Versuch, nur
`model_manifest.json` als Patch-Image zu tauschen, fuehrte deshalb zu einem
**Crash-Loop** aller Worker:

- MCP/`endpoint-health`: `unhealthy: 2`, Jobs blieben `inQueue`
- `runpodctl serverless logs <id>` (Quelle `system`): wiederholtes
  `start container … : begin` **ohne jede Container-Ausgabe** – der Container
  starb vor dem Handler. Das ist die Signatur des Crash-Loops.
- Root cause lokal reproduziert: `ModelDefinition.from_dict` →
  `ValueError: invalid quantization: 'awq-int4'` (alte `_ALLOWED_QUANTIZATIONS`).
- Sofort-Rollback auf `ghcr.io/kainplanmusic/samplemonk-ai-runtime-runpod:94243aac…`
  + Queue purgen → Endpoint wieder gesund (1 ready, 0 unhealthy).

Konsequenz: `Dockerfile.manifest` kopiert jetzt **Code UND Manifest** und baut ein
**Gate** ein, das den ModelManager fuer jede Rolle aus dem Manifest konfiguriert –
Code-/Manifest-Drift kann so nicht mehr in ein Image gelangen. Der Voll-Build in
der CI (`Dockerfile.runpod`) und dieser Patch bauen denselben Stand.



---

## Übersicht aller 8 Instanzen

| # | Name | Rolle | Hauptmodell(e) | VRAM ca. | Typ |
|---|------|-------|---------------|----------|-----|
| 1 | **Brain** | App-Steuerung, Plugins, GUI, Code | Qwen3-30B-A3B-AWQ | ~18 GB | vLLM LLM |
| 2 | **Ears** | Audio-Analyse, BPM/Key, Embeddings | 7 Audio-Modelle | ~32 GB | Eigenes Runtime |
| 3 | **Voice** | Sprache, SFX, Stems | Qwen TTS 1.7B × 2 + HTDemucs + Stable Audio | ~34 GB | Eigenes Runtime |
| 4 | **Music** | Musikgenerierung, Remixe, Drops | ACE-Step 1.5 XL × 3 + LM 4B + 10 LoRAs | ~37 GB | ComfyUI / Eigenes |
| 5 | **Image HQ** | Keyframes, Texturen, Stills | FLUX.2 [dev] FP8 + Qwen-Image-2512 FP8 + 15 LoRAs + ControlNet + IP-Adapter + Upscaler | ~48 GB | ComfyUI |
| 6 | **Video Real** | Photorealistische Video-Loops | Wan 2.2 A14B FP8 + 15 LoRAs + ControlNet + IP-Adapter + Interpolation + Upscaler | ~40 GB | ComfyUI |
| 7 | **Video Abstract** | Abstrakte/stylisierte Video-Loops | LTXVideo 13B FP8 + 15 LoRAs + ControlNet + IP-Adapter + Interpolation + Upscaler | ~26 GB | ComfyUI |
| 8 | **Orchestrator** | MoA + MCP, orchestriert Instanzen 2–7 | 4 diverse LLMs (MoA) + Embeddings | ~25 GB | Agent-Runtime + MCP |

---

# Detaillierte Beschreibungen

---

## 1. Instanz: Brain

### Grunddaten
- **Name:** `samplemonk-ai-brain` (bestehend, wird upgegradet)
- **Bild:** RunPod vLLM-Worker (offiziell / Hub)
- **GPU:** A6000 48 GB
- **GPU-Pool:** AMPERE_48
- **Idle-Timeout:** 15 s
- **WorkersMin:** 0

### Modell
- **ID:** `Qwen/Qwen3-30B-A3B-AWQ`
- Quantisierung: INT4 AWQ
- Architektur: MoE (30B total, 3B aktiv pro Token, 128 Experten, 8 aktiv)
- VRAM-Bedarf: ~18–20 GB
- Kontext: 128K
- Lizenz: Apache 2.0
- Geschwindigkeit: ~60–100 tok/s auf A6000

### Begründung
- Deutlich bessere Qualität als 14B (Code, Reasoning, komplexe Anweisungen)
- Trotzdem schnell dank MoE (nur 3B aktiv pro Token)
- Perfekt für Agent-Arbeit und Tool-Calling
- Passt locker auf A6000 mit 28 GB Puffer

### Aufgaben
- Projektübergreifender Assistent (aiMONK)
- Alle Plugins verstehen & steuern
- Musik verstehen, vergleichen, einordnen
- Code-Änderungen auf Anfrage
- Hetzner / RunPod Einstellungen verwalten
- User-Interaktion & GUI-Steuerung
- Aufteilung komplexer Aufgaben → Instanz 8 (Orchestrator)

### RunPod-Konfiguration (Serverless Endpoint)
```
Name: samplemonk-ai-brain
Model: Qwen/Qwen3-30B-A3B-AWQ
Image: runpod/vllm-worker:latest
GPU: A6000 (AMPERE_48)
GPUs: 1
Container Disk: 50 GB
Idle Timeout: 15 s
Workers Min: 0
Workers Max: 1
Flashboot: true
```

---

## 2. Instanz: Ears

### Grunddaten
- **Name:** `samplemonk-ai-ears` (bestehend, wird erweitert)
- **Bild:** eigenes `samplemonk-ai-runtime-runpod`
- **Rolle:** `ears`
- **GPU:** A6000 48 GB
- **Idle-Timeout:** 15 s
- **WorkersMin:** 0

### Modell-Stack (ALLES fest vorgeladen, ~32 GB VRAM)

| # | Modell | Repository | Aufgabe | VRAM | Lizenz |
|---|--------|-----------|---------|------|--------|
| 1 | Whisper Large v3 | `openai/whisper-large-v3` | Sprache/Lyrics/Transkription | ~5 GB | MIT |
| 2 | CLAP Music | `laion/larger_clap_music` | Semantische Embeddings, Text-zu-Audio-Suche | ~4 GB | CC-BY |
| 3 | MERT-v1-330M | `m-a-p/MERT-v1-330M` | Musikalische Detail-Embeddings (Upgrade von 95M) | ~3 GB | MIT |
| 4 | Essentia + MAEST / Discogs-EffNet | `essentia/essentia` + MAEST-Modell | BPM, Key, Genre, Mood, Tanzbarkeit (CPU) | 0 GB VRAM | AGPL |
| 5 | Qwen2-Audio-7B (AWQ) | `Qwen/Qwen2-Audio-7B-Instruct` | Audio-Understanding ("hör mal rein und beschreib") | ~8 GB | Apache 2.0 |
| 6 | PyAnnote Diarization 3.1 | `pyannote/speaker-diarization-3.1` | Sprechertrennung / Vocal-Detection | ~3 GB | MIT |
| 7 | AST AudioSet | `MIT/ast-finetuned-audioset-10-10-0.4593` | Generische 527-Klassen-Sound-Events | ~3 GB | MIT |

**Gesamt VRAM: ~26 GB + 6 GB Puffer = ~32 GB**

### Entfernte Modelle (waren vorher im Register)
- Qwen-Omni → kein Use-Case, kommt später bei Bedarf

### Aufgaben
- High-End Sounderkennung & -Klassifizierung
- BPM, Key, Camelot-Kompatibilität
- Genre, Subgenre, Stimmung, Energie
- Struktur-Analyse (Intro, Verse, Build-up, Drop, Breakdown)
- Audio-Embeddings für Ähnlichkeitssuche in der Bibliothek
- Grundlagen für AutoDJ und dropMONK

### RunPod-Konfiguration
```
Name: samplemonk-ai-ears
Image: ghcr.io/kainplanmusic/samplemonk-ai-runtime-runpod:ears
Rolle: ears
GPU: A6000 (AMPERE_48)
GPUs: 1
Container Disk: 100 GB
Volume: (Network Volume für Audio-Assets)
Idle Timeout: 15 s
Workers Min: 0
Workers Max: 1
Env:
  AI_ROLE=ears
  AI_MODEL_MANIFEST=/app/model_manifest.json
  HF_TOKEN=***
```

---

## 3. Instanz: Voice

### Grunddaten
- **Name:** `samplemonk-ai-voice` (wird umgewidmet aus VoiceGen)
- **Bild:** eigenes `samplemonk-ai-runtime-runpod`
- **Rolle:** `voice`
- **GPU:** A6000 48 GB
- **Idle-Timeout:** 900 s (15 min)
- **WorkersMin:** 0

### Modell-Stack (ALLES fest vorgeladen, ~34 GB VRAM)

| # | Modell | Repository | Aufgabe | VRAM | Lizenz |
|---|--------|-----------|---------|------|--------|
| 1 | Qwen3-TTS-12Hz-1.7B-CustomVoice | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | Standard-TTS mit 9 Premium-Stimmen | ~8 GB | Apache 2.0 |
| 2 | Qwen3-TTS-12Hz-1.7B-VoiceDesign | `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | Neue Stimmen per Beschreibung | ~8 GB | Apache 2.0 |
| 3 | HTDemucs 6-stem | `facebook/htdemucs` | Stem-Trennung (Vocals, Drums, Bass, Guitar, Piano, Other) | ~8 GB | MIT |
| 4 | Stable Audio Open 1.0 | `stabilityai/stable-audio-open-1.0` | Text-to-Sound / SFX | ~10 GB | Stability-AI Community |

**Gesamt VRAM: ~34 GB → 14 GB Luft**

### Entfernte Modelle
- mms-tts-deu → von Qwen abgelöst
- bark → alt/schlecht
- xtts-v2 → Voice-Cloning, nicht benötigt
- fish-speech → Voice-Cloning, nicht benötigt
- musicgen-small / musicgen-medium → wandert zu Instanz 4 / von ACE-Step abgelöst
- bs-roformer → erst nach A/B-Test wieder aufnehmen
- rvc → Gesangs-Umwandlung, nicht benötigt
- qwen3-tts-06b → von 1.7B vollständig abgedeckt

### Aufgaben
- Sprachgenerierung (TTS) für aiMONK, DJ-Ansagen
- Neue Stimmen per Beschreibung (VoiceDesign)
- 6-Stem-Trennung für Remix / AutoDJ / dropMONK
- Soundeffekte, Drones, Impacts, Risers, Texturen

### RunPod-Konfiguration
```
Name: samplemonk-ai-voice
Image: ghcr.io/kainplanmusic/samplemonk-ai-runtime-runpod:voice
Rolle: voice
GPU: A6000 (AMPERE_48)
GPUs: 1
Container Disk: 150 GB
Volume: (Network Volume für Audio-Modelle)
Idle Timeout: 900 s
Workers Min: 0
Workers Max: 1
Env:
  AI_ROLE=voice
  AI_MODEL_MANIFEST=/app/model_manifest.json
  HF_TOKEN=***
```

---

## 4. Instanz: Music

### Grunddaten
- **Name:** `samplemonk-ai-music` (NEU)
- **Bild:** ComfyUI-basiert oder eigenes Runtime
- **Rolle:** `music`
- **GPU:** A6000 48 GB
- **Idle-Timeout:** 900 s
- **WorkersMin:** 0

### Modell-Stack (ALLES fest vorgeladen, ~37 GB VRAM)

| # | Modell | Repository | Aufgabe | VRAM | Lizenz |
|---|--------|-----------|---------|------|--------|
| 1 | ACE-Step 1.5 XL Base | `ACE-Step/acestep-v15-xl-base` | Vielseitig, alle Modi (Repaint/Cover/Extract/Lego/Complete) | ~9 GB | MIT |
| 2 | ACE-Step 1.5 XL SFT | `ACE-Step/acestep-v15-xl-sft` | Beste Audio-Qualität für Endprodukte | ~9 GB | MIT |
| 3 | ACE-Step 1.5 XL Turbo | `ACE-Step/acestep-v15-xl-turbo` | 8 Schritte, ~6× schneller für Iterationen | ~9 GB | MIT |
| 4 | acestep-5Hz-lm-4B | `ACE-Step/acestep-5Hz-lm-4B` | LM-Planer für Text → Musik-Struktur | ~8 GB | MIT |

**DiT-Modelle zusammen: ~27 GB + LM: ~8 GB = ~35 GB Grundmodell**

### LoRAs (fest vorgeladen, ~3 GB)

| # | LoRA | Genre / Stil |
|---|------|-------------|
| 1 | Techno / Hardtechno | Härterer Sound, Kick-Design |
| 2 | Hard Bounce | Bouncy, energiegeladen |
| 3 | Minimal / Deep Tech | Reduziert, tief, clean |
| 4 | Electro | Klassischer Electro-Sound |
| 5 | Beats / Breakbeats | Rhythmusgetrieben, Breakbeat |
| 6 | Counter-Stil (Industrial / EBM / Hardcore) | Aggressiv, dunkel, industriell |
| 7 | Hip Hop / Trap | 808s, Trap-Beats |
| 8 | Melodic Techno / Progressive House | Melodisch, treibend |
| 9 | Drum & Bass | Schnell, basslastig |
| 10 | Ambient / Downtempo | Atmosphärisch, langsam |

**Gesamt LoRAs: ~2–3 GB (Plattenplatz + VRAM)**

**Gesamt VRAM: ~35 + 2 = ~37 GB → 11 GB Puffer**

### Aufgaben
- Volle Titel generieren (besonders Techno/Electro, aber auch andere Genres)
- Remixe / Repaints / Fortsetzungen
- Cover (neuer Sound über vorhandene Melodie)
- Drop-Erstellung für dropMONK
- Hintergrundmusik für Projekte
- Layering (Instrumente hinzufügen)
- Extract (Stem-Extraktion auf generativem Weg)
- Lego (baue Tracks aus einzelnen Elementen)

### RunPod-Konfiguration
```
Name: samplemonk-ai-music
Image: ghcr.io/kainplanmusic/samplemonk-ai-comfyui-music:latest
Rolle: music
GPU: A6000 (AMPERE_48)
GPUs: 1
Container Disk: 200 GB
Volume: (Network Volume für Musik-Modelle)
Idle Timeout: 900 s
Workers Min: 0
Workers Max: 1
Env:
  AI_ROLE=music
  COMFYUI_START=true
  HF_TOKEN=***
```

---

## 5. Instanz: Image HQ

### Grunddaten
- **Name:** `samplemonk-ai-visual-image` (aus Vision umgewidmet)
- **Bild:** ComfyUI-basiert
- **GPU:** A6000 48 GB
- **Idle-Timeout:** 900 s
- **WorkersMin:** 0
- KEIN Cover-Generator, KEIN Text-in-Bild-Fokus

### Modell-Stack (ALLES fest vorgeladen, ~48 GB – knapp)

| # | Komponente | Modell / Typ | Aufgabe | VRAM | Lizenz |
|---|-----------|--------------|---------|------|--------|
| 1 | Basismodell 1 | FLUX.2 [dev] FP8 | Höchste Bildqualität, Photorealismus | ~32 GB | Non-Commerical frei / Kommerziell: BFL-Lizenz nötig |
| 2 | Basismodell 2 | Qwen-Image-2512 FP8 | Illustration, Comic, Texturen, abstrakt | ~15 GB | Apache 2.0 |
| 3 | ControlNet 1 | Depth (Tiefenkarte) | Kompositionssteuerung | ~1,5 GB | Apache 2.0 |
| 4 | ControlNet 2 | Canny / Edge | Kanten-/Formsteuerung | ~1,5 GB | Apache 2.0 |
| 5 | IP-Adapter | FLUX + Qwen jeweils | Stil-Transfer aus Referenzbildern | ~2 GB | Apache 2.0 |
| 6 | Upscaler | ESRGAN 4x / Real-ESRGAN | 2K/4K-Hochskalierung | ~1 GB | MIT |

**Gesamt: ~32 + 15 + 6 = ~53 GB → passt NICHT in 48 GB gleichzeitig.**

### Lösung: Dynamisches Laden (kein on-demand im klassischen Sinne)
Beide Basismodelle sind auf Platte verfügbar und vorkonfiguriert. Das aktive Modell wird je Aufgabe in < 10 Sekunden gewechselt. ControlNet, IP-Adapter und Upscaler bleiben immer im Speicher.

- FLUX.2 aktiv: ~32 + 6 = ~38 GB → 10 GB Puffer
- Qwen-Image aktiv: ~15 + 6 = ~21 GB → 27 GB Puffer

Grund für diese Lösung:
- Wechsel ist schnell (< 10 s)
- Kein Kaltstart der ganzen Instanz
- Beide Modelle sind sofort verfügbar, nur nicht gleichzeitig im VRAM
- Passt perfekt auf eine A6000

### LoRAs (15 Stück, ~2–3 GB – werden bei Bedarf zugeladen)

| # | LoRA | Stil / Kategorie |
|---|------|-----------------|
| 1 | Realistic / Photorealism | Fotorealistisch, Landschaften, Cityscapes |
| 2 | Comic / Graphic Novel | Comic, gezeichnet, illustriert |
| 3 | Cyberpunk / Neon | Neon, Tech, Zukunft, Stadt |
| 4 | Fractal / Abstract Geometry | Fraktale, geometrisch, mathematisch |
| 5 | Liquid / Fluid Art | Flüssig, organisch, abstrakt |
| 6 | Glitch / Datamosh | Glitch, digital, zerstört |
| 7 | Particles / Light Rays | Partikel, Licht, Strahlen |
| 8 | Minimal / Bauhaus | Reduziert, geometrisch, clean |
| 9 | Psychedelic / Psy | Trippy, farbenfroh, Muster |
| 10 | Oil Painting / Artistic | Gemalt, künstlerisch, malerisch |
| 11 | Dark / Zombie / Horror | Dunkel, Horror, Zombie, Gothic |
| 12 | Krieg / Military | Militär, Schlacht, Wüsten |
| 13 | Aliens / Galaxie / Sci-Fi | Weltraum, Aliens, Science-Fiction |
| 14 | Geschichte (Western / China / Steinzeit / Mittelalter) | Historische Szenen |
| 15 | Tierwelt | Tiere, Natur, Wildlife |

**→ 15 LoRAs á 50–300 MB = ~2–3 GB**

### Eingangsmodi
- **Text → Bild** (T2I)
- **Bild → Bild** (I2I / Stil-Transfer)
- **Referenzbild → Serien** (IP-Adapter, konsistenter Stil)

### Aufgaben
- Keyframes pro Track-Abschnitt (Intro/Build-up/Drop/Breakdown)
- Abstrakte Texturen & Stills als Quelle für Video-Loops
- Stil-Referenzen für Instanz 6 + 7 (Video)
- Kompletter Stil-Bereich: photorealistisch ↔ Comic ↔ Fraktal ↔ Cyberpunk ↔ Horror ↔ Sci-Fi ↔ Historisch

### RunPod-Konfiguration
```
Name: samplemonk-ai-visual-image
Image: ghcr.io/kainplanmusic/samplemonk-ai-comfyui-image:latest
GPU: A6000 (AMPERE_48)
GPUs: 1
Container Disk: 200 GB
Volume: (Network Volume für Bild-Modelle + Assets)
Idle Timeout: 900 s
Workers Min: 0
Workers Max: 1
Env:
  AI_ROLE=visual_image
  COMFYUI_START=true
  HF_TOKEN=***
  MODELS_PRELOAD=flux2_fp8,qwen_image_2512_fp8
  CONTROLNET_PRELOAD=depth,canny
  IPADAPTER_PRELOAD=true
  UPSCALER_PRELOAD=esrgan4x
```

---

## 6. Instanz: Video Real

### Grunddaten
- **Name:** `samplemonk-ai-video-real` (NEU)
- **Bild:** ComfyUI Video-Worker
- **GPU:** A6000 48 GB
- **Idle-Timeout:** 900 s
- **WorkersMin:** 0

### Modell-Stack (ALLES fest vorgeladen, ~40 GB VRAM)

| # | Komponente | Modell | Aufgabe | VRAM | Lizenz |
|---|-----------|--------|---------|------|--------|
| 1 | Basismodell | Wan 2.2 A14B FP8 | Photorealistische Video-Generierung | ~32 GB | Apache 2.0 |
| 2 | Text-Encoder | UMT5-XXL FP8 | Text-Embedding für Prompts | inkludiert | Apache 2.0 |
| 3 | VAE | Wan-VAE | Video-Enkodierung/Dekodierung | inkludiert | Apache 2.0 |
| 4 | ControlNet 1 | Depth (Video) | Tiefensteuerung über Zeit | ~2 GB | Apache 2.0 |
| 5 | ControlNet 2 | Canny / Edge (Video) | Kanten-/Formstabilität über Frames | ~2 GB | Apache 2.0 |
| 6 | IP-Adapter (Video) | Wan IP-Adapter | Stil-Transfer auf komplette Videos | ~2 GB | Apache 2.0 |
| 7 | Interpolation | RIFE 4x | 24 → 48/60 fps, flüssige Loops | ~1 GB | MIT |
| 8 | Video-Upscaler | Real-ESRGAN Video 4x | 480p/720p → 1080p | ~2 GB | MIT |

**Gesamt: ~32 + 7 = ~39 GB → 9 GB Puffer**

### LoRAs (15 Stück, passend zu Bild – gleicher Stil-Katalog)

| # | LoRA | Stil |
|---|------|------|
| 1 | Cinematic / Filmisch | Kino, filmisch, cineastisch |
| 2 | Realistic Enhance | Realismus-Verbesserung |
| 3 | Anime / Comic | Anime, Comic, Zeichentrick |
| 4 | Cyberpunk / Neon | Neon, Tech, Zukunft |
| 5 | Horror / Dark Atmosphere | Dunkel, Horror, Gothic |
| 6 | + 10 weitere passend zur Bild-Instanz | (gleiches Stil-Spektrum) |

→ 15 LoRAs á 100–300 MB = ~2–3 GB

### Eingangsmodi
- **Text → Video** (T2V)
- **Bild → Video** (I2V / Image-to-Video)
- **Bild-Diashow → Video** (mehrere Keyframes → flüssiger Übergang)
- **Video → Video** (Stil-Transfer via IP-Adapter)

### Aufgaben
- Photorealistische Video-Loops (Sonnenuntergänge, Landschaften, Cityscapes, Sci-Fi)
- Drop-Animationen mit realistischem Look
- Historische und realistische Szenen
- Keyframes von Instanz 5 → bewegte Clips (hohe Qualität)

### RunPod-Konfiguration
```
Name: samplemonk-ai-video-real
Image: ghcr.io/kainplanmusic/samplemonk-ai-comfyui-video:latest
GPU: A6000 (AMPERE_48)
GPUs: 1
Container Disk: 200 GB
Volume: (Network Volume für Video-Modelle + Assets)
Idle Timeout: 900 s
Workers Min: 0
Workers Max: 1
Env:
  AI_ROLE=video_real
  COMFYUI_START=true
  HF_TOKEN=***
  VIDEO_BASE_MODEL=wan2.2_a14b_fp8
  CONTROLNET_PRELOAD=depth,canny
  IPADAPTER_PRELOAD=true
  INTERPOLATION=rife4x
  UPSCALER=real_esrgan_video_4x
```

---

## 7. Instanz: Video Abstract

### Grunddaten
- **Name:** `samplemonk-ai-video-abstract` (NEU)
- **Bild:** ComfyUI Video-Worker
- **GPU:** A6000 48 GB
- **Idle-Timeout:** 900 s
- **WorkersMin:** 0

### Modell-Stack (ALLES fest vorgeladen, ~26 GB VRAM)

| # | Komponente | Modell | Aufgabe | VRAM | Lizenz |
|---|-----------|--------|---------|------|--------|
| 1 | Basismodell | LTXVideo 13B FP8 | Abstrakte/stylisierte Video-Generierung | ~18 GB | LTX Community / Kommerziell |
| 2 | ControlNet 1 | Depth (Video) | Tiefensteuerung | ~2 GB | Apache 2.0 |
| 3 | ControlNet 2 | Canny / Edge (Video) | Kanten-/Formsteuerung | ~2 GB | Apache 2.0 |
| 4 | IP-Adapter (Video) | LTX IP-Adapter | Stil-Transfer | ~2 GB | Apache 2.0 |
| 5 | Interpolation | RIFE 4x | Frame-Interpolation | ~1 GB | MIT |
| 6 | Video-Upscaler | Real-ESRGAN Video 4x | Hochskalierung | ~2 GB | MIT |

**Gesamt: ~18 + 7 = ~25 GB → 23 GB Puffer**

**→ Viel Luft für höhere Auflösung, längere Clips, mehrere LoRAs gleichzeitig**

### LoRAs (15 Stück, gleiches Stil-Spektrum wie Bild)

| # | LoRA | Stil |
|---|------|------|
| 1 | Abstract Motion / VJ-Style | Abstrakt, VJ, bewegte Muster |
| 2 | Glitch / Datamosh | Glitch, digital, zerstört |
| 3 | Neon Motion / Cyberpunk | Neon, Licht, Bewegung |
| 4 | Liquid / Fluid Motion | Flüssig, organisch, fluid |
| 5 | Particles / Light Trails | Partikel, Lichtspuren |
| 6 | + 10 weitere passend zur Bild-Instanz | (gleiches Stil-Spektrum) |

→ 15 LoRAs á 100–300 MB = ~2–3 GB

### Eingangsmodi
- **Text → Video** (T2V)
- **Bild → Video** (I2V)
- **Video → Video** (Stil-Transfer)

### Aufgaben
- Abstrakte Video-Loops für Techno/Electro
- Schnelle, dynamische Visuals
- Drop-Animationen (kurz, intensiv, glitchig)
- Stylisierte/abstrakte Übergänge zwischen Stilen
- Motion-Graphics-artige Clips

### RunPod-Konfiguration
```
Name: samplemonk-ai-video-abstract
Image: ghcr.io/kainplanmusic/samplemonk-ai-comfyui-video:latest
GPU: A6000 (AMPERE_48)
GPUs: 1
Container Disk: 200 GB
Volume: (Network Volume für Video-Modelle + Assets)
Idle Timeout: 900 s
Workers Min: 0
Workers Max: 1
Env:
  AI_ROLE=video_abstract
  COMFYUI_START=true
  HF_TOKEN=***
  VIDEO_BASE_MODEL=ltxvideo_13b_fp8
  CONTROLNET_PRELOAD=depth,canny
  IPADAPTER_PRELOAD=true
  INTERPOLATION=rife4x
  UPSCALER=real_esrgan_video_4x
```

---

## 8. Instanz: AI Orchestrator (MoA + MCP)

### Grunddaten
- **Name:** `samplemonk-ai-orchestrator` (NEU)
- **Bild:** Agent-Runtime-Image (LangGraph / eigenes Framework) + MCP-Server
- **Rolle:** `orchestrator`
- **GPU:** A6000 48 GB
- **Idle-Timeout:** 900 s
- **WorkersMin:** 0

### MoA-Modell-Stack (DIVERSE Modelle – 4 Anbieter, ALLES fest vorgeladen)

| # | Modell | Größe | Hersteller | Aufgabe im MoA | VRAM | Lizenz |
|---|--------|-------|------------|---------------|------|--------|
| 1 | Mistral-Small-3.1 | 8B | Mistral | Haupt-Pipeline-Planer, Tool-Calling (Aggregator) | ~8 GB FP8 | Apache 2.0 |
| 2 | Qwen3-4B | 4B | Qwen | Schnell-Klassifizierer, einfache Entscheidungen (Classifier) | ~4 GB FP8 | Apache 2.0 |
| 3 | Gemma 3 7B | 7B | Google | Audio-Prompt-Formulierung, Musik-Beschreibungen (Planner 2) | ~7 GB FP8 | Google Gemma |
| 4 | Llama 3.2 3B Instruct | 3B | Meta | Visual-Prompt-Optimierung, Stil-Matching (Planner 1) | ~3 GB FP8 | Meta Llama 3 |

**→ 4 Modelle von 4 verschiedenen Anbietern**
**→ Diversität = MoA gewinnt durch unterschiedliche Blickwinkel**
**→ Gesamt: ~22 GB → 26 GB Puffer auf A6000**

### MoA-Architektur (3 Schichten)

```
User-Aufgabe (von Brain)
        ↓
[Schicht 1: Classifier] Qwen3-4B
  → Was für eine Aufgabe? Audio? Visual? Beides?
  → Welche Instanzen werden benötigt?
        ↓
[Schicht 2: Planner]  parallel
  → Planner A: Llama 3.2 3B (Visual-Fokus)
  → Planner B: Gemma 3 7B (Audio-Fokus)
  → Beide erstellen unabhängig einen detaillierten Pipeline-Plan
        ↓
[Schicht 3: Aggregator] Mistral-Small-3.1 8B
  → Vergleicht beide Pläne
  → Wählt den besseren / kombiniert
  → Erstellt den finalen Ablauf
  → Führt die Pipeline aus (Tool-Calls via MCP)
        ↓
Ergebnis (zurück an Brain)
```

### MCP-Clients (Tools für den Agenten)
Jede der 6 Spezial-Instanzen ist über MCP als Tool erreichbar:

#### ears.*
- `ears.analyze(audio, tasks[])` → Metadaten (BPM, Key, Genre, Struktur, Energie)
- `ears.transcribe(audio, language)` → Text-Transkription
- `ears.embed(audio, model)` → Audio-Embedding-Vektor
- `ears.classify(audio, classes)` → Klassifikation
- `ears.diarize(audio)` → Sprechertrennung

#### voice.*
- `voice.tts(text, voice, language, speed)` → Sprach-Audio
- `voice.voice_design(text, description, language)` → Neue Stimme per Beschreibung
- `voice.stem_separate(audio, stems)` → Stem-Trennung
- `voice.sfx(prompt, duration)` → Soundeffekt / SFX

#### music.*
- `music.generate(prompt, genre, duration, variant, lora)` → Track generieren
- `music.remix(audio, style, lora)` → Remix / Stil-Transfer
- `music.drop(prompt, genre, duration, lora)` → Drop generieren
- `music.repaint(audio, mask, prompt)` → Teil-Repaint
- `music.complete(audio, direction, duration)` → Track fortsetzen

#### image.*
- `image.generate(prompt, style, lora, model, controlnet)` → Bild generieren
- `image.img2img(image, prompt, lora, denoise)` → Bild zu Bild
- `image.keypoints(track_sections, style)` → Keyframes für Track-Abschnitte
- `image.upscale(image, factor)` → Hochskalieren

#### video_real.*
- `video_real.text2video(prompt, duration, fps, resolution)` → Text zu Video
- `video_real.img2video(image, prompt, duration, motion)` → Bild zu Video
- `video_real.slideshow(images[], transitions)` → Diashow zu Video
- `video_real.loop(prompt, style, duration)` → Nahtloser Loop

#### video_abstract.*
- `video_abstract.text2video(prompt, duration, fps, resolution)` → Text zu Video
- `video_abstract.img2video(image, prompt, duration, motion)` → Bild zu Video
- `video_abstract.loop(prompt, style, duration)` → Nahtloser Loop
- `video_abstract.glitch(audio_sync, intensity)` → Glitch-Effekt

### Zusätzliche Komponenten (~4 GB VRAM + RAM)
- **Text-Embedding:** BGE-M3 (~2 GB) – für Prompt-Verbesserung, Similarity
- **Bild-Embedding:** CLIP ViT-L/14 (~2 GB) – für Stil-Matching, Suche
- **Audio-Embedding-Cache** – Ergebnisse von Ears wiederverwenden
- **Agent-Framework:** LangGraph oder eigenes leichtgewichtiges Framework

### Aufgaben
- Nimmt komplexe Multimodal-Aufträge von Brain entgegen
- Orchestriert Instanzen 2–7 vollautomatisch
- Baut Pipelines aus mehreren KI-Schritten zusammen
- Qualitätsprüfung der Ergebnisse zwischen den Schritten
- Gibt fertige Pakete zurück (Track + Stems + Visuals + Metadaten)
- Verwaltet Zwischenergebnisse und Caching

### RunPod-Konfiguration
```
Name: samplemonk-ai-orchestrator
Image: ghcr.io/kainplanmusic/samplemonk-ai-orchestrator:latest
GPU: A6000 (AMPERE_48)
GPUs: 1
Container Disk: 100 GB
Idle Timeout: 900 s
Workers Min: 0
Workers Max: 1
Env:
  AI_ROLE=orchestrator
  MOA_MODELS=mistral_small_3.1_8b,qwen3_4b,gemma3_7b,llama3.2_3b
  MCP_ENDPOINTS=ears,voice,music,image,video_real,video_abstract
  LANGGRAPH_SERVER=true
  HF_TOKEN=***
```

---

# Cross-Cutting Systeme

## AutoDJ / AutoMixer
- Nutzt Ears (BPM/Key/Genre/Energie) + regelbasierte Mixing-Engine lokal im Audio-Backend
- Brain plant bei Bedarf die Mischung und gibt Empfehlungen
- Das eigentliche Mixen (EQ, Filter, Crossfader) läuft LOKAL im Audio-Engine-Worklet, NICHT auf RunPod → zu wichtig für niedrige Latenz

## dropMONK
- Brain erstellt Konzept & Struktur (Drop-Länge, Energie, Timing)
- Ears erkennt BPM, Key, freie Stelle, Drop-Punkt im bestehenden Track
- Music generiert den Drop selbst (oder passende Elemente)
- Voice liefert SFX / Percussion / Effekte dazu (Stable Audio)
- Keine Sprachausgabe nötig – dropMONK ist kein MC, es baut Drops
- Lokale Audio-Engine fügt alles beatgenau ein und speichert als Asset

## Visual-Choreographie-System
- Eingang: Track + Metadaten (von Ears)
- Orchestrator (Instanz 8) erstellt Timeline: Abschnitt → Stil + Farbe + Intensität
- Instanz 5 erzeugt Keyframes pro Abschnitt
- Instanz 6 + 7 erzeugen Loops + Übergänge
- Ausgabe geht an das Visualizer-Plugin im Frontend
- Assets werden in `visual-assets/` gespeichert

## Asset-Verzeichnis-Struktur

```
audio-assets/
├── tracks/         # Vollständige Tracks
├── stems/          # Einzelne Stems
├── drops/          # Drop-Elemente
├── sfx/            # Soundeffekte
└── loops/          # Audio-Loops

visual-assets/
├── loops/          # Beat-sync Video-Loops (nach Stil/BPM sortiert)
├── drops/          # Drop-Animationen (kurz, intensiv)
├── textures/       # Abstrakte Texturen & Stills
├── fx/             # Einzel-Effekte (Glitch, Licht, Partikel)
├── keyframes/      # Keyframes pro Abschnitt / Track
├── videos/         # Fertige Video-Clips
└── uploads/        # User-Uploads zur Weiterverarbeitung
```

---

# MCP-Architektur & Backend-Anbindung

## Gesamt-Architektur

```
┌─────────────────────────────────────────────────────────────────┐
│                        audioMONASTRY App                        │
│  (Browser / Electron)                                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS / WebSocket
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Haupt-Backend (Hetzner)                     │
│  - Orchestrierung                                                │
│  - Authentifizierung                                            │
│  - Asset-Speicher (Object Storage)                              │
│  - WebSocket Gateway                                            │
└───┬───────────────────────┬───────────────────────────────────┬─┘
    │                       │                                   │
    ▼                       ▼                                   ▼
┌──────────┐         ┌──────────────┐                    ┌──────────────┐
│  Brain   │         │ Orchestrator │      ...           │  Ears + 5+   │
│  (Instanz 1)       │  (Instanz 8) │                    │  Instanzen    │
│  vLLM    │         │  MoA + MCP   │                    │  2–7          │
└──────────┘         └──────────────┘                    └──────────────┘
     RunPod Serverless Endpoints (scale-to-zero)
```

## Brain ↔ App
- Direkte OpenAI-kompatible API (vLLM)
- Streaming-Antworten
- Tool-Calls für Plugin-Steuerung gehen direkt ans Backend

## Brain ↔ Orchestrator
- Brain gibt Multimodal-Aufträge an Orchestrator weiter
- Orchestrator führt komplexe Pipelines aus
- Orchestrator gibt fertige Ergebnisse (Assets + Metadaten) zurück

## Orchestrator ↔ Instanzen 2–7
- Jede Instanz bietet eine REST-API + MCP-Server
- Orchestrator spricht sie via MCP-Tools an
- Ergebnisse werden als Asset-URIs zurückgegeben

## App ↔ Instanzen
- App ruft Instanzen NIEMALS direkt auf
- Alles geht durch Haupt-Backend + Brain + Orchestrator
- Einzige Ausnahme: Asset-Downloads aus Object Storage

---

# Vorbereitungen & Umsetzungsplan

## Phase 0: Vorbereitung (vor RunPod-Änderungen)
1. [ ] `model_manifest.json` komplett überarbeiten und auf 8 Rollen anpassen
2. [ ] Endpunkt-Registry im Backend auf 8 Instanzen erweitern
3. [ ] MCP-Server für jede Instanz implementieren
4. [ ] Orchestrator-Framework aufbauen (LangGraph o.ä.)
5. [ ] Docker-Images vorbereiten / anpassen
6. [ ] Network Volumes anlegen (Audio-Modelle, Video-Modelle, Assets)
7. [ ] GHCR-Credentials prüfen

## Phase 1: Bestehende Instanzen upgraden
1. [ ] Brain: 14B → 30B-A3B-AWQ (einfacher Modellaustausch im vLLM-Worker)
2. [ ] Ears: MERT 95M → 330M, Qwen2-Audio-7B + PyAnnote + AST ins Preload, Qwen-Omni entfernen
3. [ ] Voice: Qwen3-TTS 1.7B CustomVoice + VoiceDesign hinzufügen, HTDemucs 6-stem statt 4-stem, Stable Audio hinzufügen, Alte Modelle entfernen

## Phase 2: Neue Instanzen erstellen
1. [ ] Music-Instanz (ACE-Step XL × 3 + 10 LoRAs)
2. [ ] Image HQ Instanz (FLUX.2 FP8 + Qwen-Image-2512 FP8 + ControlNet + IP-Adapter + 15 LoRAs)
3. [ ] Video Real Instanz (Wan 2.2 A14B + ControlNet + IP-Adapter + 15 LoRAs)
4. [ ] Video Abstract Instanz (LTXVideo 13B + ControlNet + IP-Adapter + 15 LoRAs)
5. [ ] Orchestrator Instanz (4 LLMs + MCP + Agent-Framework)

## Phase 3: Integration
1. [ ] MCP-Client im Orchestrator für alle 6 Instanzen implementieren
2. [ ] MoA-Logik testen (Classifier → Planner → Aggregator)
3. [ ] Visual-Choreographie-Pipeline testen
4. [ ] dropMONK-Pipeline testen
5. [ ] AutoDJ-Pipeline testen

## Phase 4: App-Anbindung
1. [ ] Frontend-Plugin für Visualizer erweitern
2. [ ] Frontend-Bedienoberfläche für KI-Funktionen
3. [ ] Asset-Manager im Frontend (Audio + Visual)
4. [ ] Fortschrittsanzeige für KI-Aufträge
5. [ ] Fehlerbehandlung & Retry-Logik

## Phase 5: Test & Abnahme
1. [ ] Jede Instanz einzeln testen
2. [ ] Komplexe Pipelines testen (z.B. "Track + Visuals aus einem Prompt")
3. [ ] Latenz-Messungen
4. [ ] Kosten-Überwachung
5. [ ] End-to-End-Test mit echtem Track

---

# Lizenz-Übersicht

| Modell | Lizenz | Kommerzielle Nutzung? |
|--------|--------|----------------------|
| Qwen3-30B-A3B | Apache 2.0 | ✅ Ja |
| Whisper Large v3 | MIT | ✅ Ja |
| CLAP Music | CC-BY | ✅ Ja (Namensnennung) |
| MERT-v1-330M | MIT | ✅ Ja |
| Essentia | AGPL | ✅ Ja (Copyleft) |
| Qwen2-Audio-7B | Apache 2.0 | ✅ Ja |
| PyAnnote | MIT | ✅ Ja |
| AST AudioSet | MIT | ✅ Ja |
| Qwen3-TTS 1.7B | Apache 2.0 | ✅ Ja |
| HTDemucs | MIT | ✅ Ja |
| Stable Audio Open 1.0 | Stability-AI-Community | ⚠️ Bedingt (Community-Lizenz prüfen) |
| ACE-Step 1.5 XL | MIT | ✅ Ja |
| FLUX.2 [dev] | Non-Commercial / BFL | ❌ Nicht kommerziell (kommerzielle Lizenz separat) |
| Qwen-Image-2512 | Apache 2.0 | ✅ Ja |
| Wan 2.2 A14B | Apache 2.0 | ✅ Ja |
| LTXVideo 13B | LTX-Community | ⚠️ Bedingt (prüfen) |
| Mistral-Small-3.1 | Apache 2.0 | ✅ Ja |
| Gemma 3 7B | Google Gemma | ✅ Ja |
| Llama 3.2 3B | Meta Llama 3 | ✅ Ja (Akzeptanz der Meta-Lizenz) |

**Wichtigste Lizenz-Risiken:**
- FLUX.2 [dev]: Nicht kommerziell frei. Wenn audioMONASTRY monetarisiert wird → entweder BFL-Lizenz kaufen oder auf Qwen-Image + FLUX.2-klein (Apache 2.0) umsteigen.
- Stable Audio Open: Stability-Community-Lizenz → Nutzungsbedingungen prüfen.
- LTXVideo: Lizenzbedingungen prüfen.

---

# Kosten
- **Vollast (8 × A6000):** ~3,20 €/h
- **Bei 10 h/Monat:** ~32 €/Monat
- **Scale-to-zero:** 0 € wenn nicht genutzt
- **Network Volumes:** ~0,50 €/GB/Monat (ca. 100 GB = ~50 €/Monat – nur falls permanent)
  - Alternative: Modelle werden pro Cold Start neu geladen (kostenlos, aber langsamer Start)

---

# Offene Punkte
- [ ] FLUX.2 kommerzielle Lizenz klären (oder auf Qwen-Image-only setzen)
- [ ] Stable Audio Open Lizenz prüfen
- [ ] LTXVideo Lizenz prüfen
- [ ] Agent-Framework wählen (LangGraph vs. eigenes)
- [ ] Network Volume Strategie festlegen (cachen vs. jedes Mal neu laden)
- [ ] Deployment-Reihenfolge festlegen
