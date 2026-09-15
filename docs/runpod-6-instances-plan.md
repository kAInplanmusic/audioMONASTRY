# RunPod 6-Instanzen-Architektur – Planstand (Entscheidungsphase)

Stand: 2026-09-15
Status: Architektur entschieden, noch nicht deployed / gepusht.
Alle Instanzen: A6000 48 GB, scale-to-zero mit idle-Timeout (App max. 10 h/Monat im Einsatz).

---

## 1. Brain — AI-MONK (Text, Planung, Tool-Calling)

- Instanz: `samplemonk-ai-brain` (bestehend)
- Bild: RunPod vLLM-Worker
- Modell: `Qwen/Qwen3-30B-A3B-AWQ` (4-bit, MoE, 3B aktiv / 30B total)
- Begründung: deutlich bessere Qualität (Code, Reasoning, komplexe Anweisungen) als 14B, aber trotzdem schnell dank MoE (nur 3B aktiv pro Token). Passt locker auf A6000.
- Aufgaben:
  - Projektübergreifender Assistent (aiMONK)
  - Alle Plugins verstehen & steuern
  - Musik verstehen, vergleichen, einordnen
  - Code-Änderungen auf Anfrage
  - Hetzner / RunPod Einstellungen verwalten
  - Orchestrierung von Ears/Voice/Music/Visuals
- Preload: Qwen3-14B-AWQ
- On-demand im Register: Qwen3-4B, Qwen3-32B, Qwen3-30B-A3B, GLM-4.5-Air
- Idle-Timeout: 15 s

---

## 2. Ears — Audio Intelligence (Analyse, Tags, Embeddings, Retrieval)

- Instanz: `samplemonk-ai-ears` (bestehend)
- Bild: eigenes samplemonk-ai-runtime-runpod
- Rolle: `ears`
- Vorgeladen (ALLES fest im Speicher, ~32 GB VRAM):
  1. **Whisper Large v3** — Sprache/Lyrics/Transkription (höchste Qualität)
  2. **CLAP Music (Laion)** — semantische Embeddings, Text-zu-Audio-Suche
  3. **MERT-v1-330M** — musikalische Detail-Embeddings (Upgrade von 95M)
  4. **Essentia + MAEST / Discogs-EffNet** — BPM, Key, Genre, Mood, Tanzbarkeit (CPU)
  5. **Qwen2-Audio-7B (AWQ)** — Audio-Understanding ("hör mal rein und beschreib")
  6. **PyAnnote Diarization 3.1** — Sprechertrennung / Vocal-Detection
  7. **AST AudioSet** — generische 527-Klassen-Sound-Events
- Entfernt (fliegt komplett raus, KEIN on-demand):
  - Qwen-Omni (kein Use-Case, kommt später bei Bedarf)
- Aufgaben:
  - High-End Sounderkennung & -Klassifizierung
  - BPM, Key, Camelot-Kompatibilität
  - Genre, Subgenre, Stimmung, Energie
  - Struktur-Analyse (Intro, Verse, Build-up, Drop, Breakdown)
  - Audio-Embeddings für Ähnlichkeitssuche in der Bibliothek
  - Grundlagen für AutoDJ und dropMONK
- Idle-Timeout: 15 s

---

## 3. Voice — Sprache + SFX + Stems (aus VoiceGen geteilt)

- Instanz: `samplemonk-ai-voice` (wird umgewidmet / verkleinert)
- Bild: eigenes samplemonk-ai-runtime-runpod
- Rolle: `voice`
- Vorgeladen:
  1. Qwen3-TTS-12Hz-1.7B-CustomVoice — Standard-TTS mit 9 Premium-Stimmen
  2. Qwen3-TTS-12Hz-1.7B-VoiceDesign — frei beschreibbare neue Stimmen
  3. HTDemucs 6-stem — Stem-Trennung (Vocals, Drums, Bass, Guitar, Piano, Other)
  4. Stable Audio Open 1.0 — Text-to-Sound / SFX
- Entfernt (fliegt komplett raus):
  - mms-tts-deu (von Qwen abgelöst)
  - bark (alt/schlecht)
  - xtts-v2 (Voice-Cloning, nicht benötigt)
  - fish-speech (Voice-Cloning, nicht benötigt)
  - musicgen-small / musicgen-medium (wandert zu Instanz 4 / von ACE-Step abgelöst)
  - bs-roformer (erst nach A/B-Test wieder aufnehmen, falls Demucs nicht reicht)
  - rvc (Gesangs-Umwandlung, nicht benötigt)
- Aufgaben:
  - Sprachgenerierung (TTS) für aiMONK, dropMONK, DJ-Ansagen
  - Neue Stimmen per Beschreibung (VoiceDesign)
  - 6-Stem-Trennung für Remix / AutoDJ / dropMONK
  - Soundeffekte, Drones, Impacts, Risers, Texturen
- VRAM-Budget: ~12 + ~8 + ~10 = ~30 GB → 18 GB Luft
- Idle-Timeout: 900 s (15 min)

---

## 4. Music — Musikgenerator (NEUE INSTANZ)

- Instanz: `samplemonk-ai-music` (neu)
- Bild: eigenes samplemonk-ai-runtime-runpod oder ComfyUI-basiert
- Rolle: `music`
- Vorgeladen (ALLES fest im Speicher, ~37 GB VRAM):
  1. **ACE-Step 1.5 XL Base** (DiT 4B, ~9 GB) — Vielseitig, alle Modi (Repaint/Cover/Extract/Lego/Complete)
  2. **ACE-Step 1.5 XL SFT** (DiT 4B, ~9 GB) — Beste Audio-Qualität für Endprodukte
  3. **ACE-Step 1.5 XL Turbo** (DiT 4B, ~9 GB) — 8 Schritte, ~6× schneller für Iterationen
  4. **acestep-5Hz-lm-4B** (~8 GB) — LM-Planer für Text → Musik-Struktur
  5. **Genre-LoRAs (fest vorgeladen):**
     - Techno / Hardtechno
     - Hard Bounce
     - Minimal / Deep Tech
     - Electro
     - Beats / Breakbeats
     - Counter-Stil (Industrial / EBM / Hardcore)
     - Hip Hop / Trap
     - Melodic Techno / Progressive House
     - Drum & Bass
     - Ambient / Downtempo
  → 10 LoRAs á ~200–500 MB = ~3 GB insgesamt
- Entfernt (fliegt komplett raus):
  - musicgen-small / musicgen-medium (vollständig von ACE-Step abgelöst)
- Aufgaben:
  - Volle Titel generieren (besonders Techno/Electro, aber auch andere Genres)
  - Remixe / Repaints / Fortsetzungen
  - Drop-Erstellung für dropMONK
  - Hintergrundmusik für Projekte
- VRAM-Budget: ~24 GB → 24 GB Luft (LoRAs, Puffer, Tempspeicher)
- Idle-Timeout: 900 s (15 min)

---

## 5. Visual Image — Universal Visual Source (NEU, aus Vision umgewidmet)

- Instanz: `samplemonk-ai-visual-image` (bisher `samplemonk-ai-vision`)
- Bild: ComfyUI-basiert
- Modell-Stack (ALLES fest vorgeladen, ~36 GB VRAM):
  1. **FLUX.2 [dev] Q4_K_M-GGUF** (~16 GB) — Hauptmodell, hochwertige Photorealistik
     - Quantisierung Q4_K_M: für Musik-Visuals nicht sichtbar schlechter als FP8,
       spart aber ~16 GB VRAM für mehr Erweiterungen
  2. **Qwen-Image-2512 FP8** (~15 GB) — Zweitmodell, stärker bei Illustration/Comic/Texturen
     - Lizenzsicher (Apache 2.0), komplettiert FLUX auf der stilistischen Seite
  3. **ControlNet (Depth)** — Tiefenkarten zur Kompositionssteuerung
  4. **ControlNet (Canny / Edge)** — Kanten-/Formsteuerung für geometrische Visuals
  5. **IP-Adapter** — Stil-Transfer aus Referenzbildern (ersetzt 5+ LoRAs)
  6. **Upscaler (ESRGAN / 4x)** — 2K/4K-Hochskalierung
- LoRAs (fest vorgeladen, ~2–3 GB):
  1. Realistic / Photorealism
  2. Comic / Graphic Novel
  3. Cyberpunk / Neon
  4. Fractal / Abstract Geometry
  5. Liquid / Fluid Art
  6. Glitch / Datamosh
  7. Particles / Light Rays
  8. Minimal / Bauhaus
  9. Psychedelic / Psy
 10. Oil Painting / Artistic
 11. Dark / Zombie / Horror
 12. Krieg / Military
 13. Aliens / Galaxie / Sci-Fi
 14. Geschichte (Western / China / Steinzeit / Mittelalter)
 15. Tierwelt
 → 15 LoRAs á 50–300 MB = ~2–3 GB
- Gesamt-VRAM: ~16 + 15 + 2 + 3 = ~36 GB → 12 GB Puffer
- KEIN Cover-Generator, KEIN Text-in-Bild-Fokus
- Aufgaben:
  - Keyframes pro Track-Abschnitt (Intro/Build-up/Drop/Breakdown)
  - Abstrakte Texturen & Stills als Quelle für Video-Loops
  - Stil-Referenzen für Instanz 6 (Video)
  - Kompletter Stil-Bereich: photorealistisch ↔ Comic ↔ Fraktal ↔ Cyberpunk ↔ Horror ↔ Sci-Fi ↔ Historisch
- Aufgaben:
  - Keyframes für Visual-Choreographie pro Track-Abschnitt
  - Abstrakte Texturen als Quelle für Video-Loops
  - Stimmungsbilder / Referenz-Frames für Instanz 6
  - Kompletter Stil-Spektrum: photorealistisch → Comic → Fraktal → Cyberpunk → Glitch
- VRAM-Budget: ~32 GB Modell + ~4 GB LoRAs + Arbeitspeicher = ~40 GB
- Idle-Timeout: 900 s

---

## 6. Visual Video — Style-Shifting Motion Engine (NEU)

- Instanz: `samplemonk-ai-orchestrator` (NEU)
- Bild: Agent-Runtime (LangGraph / AutoGen / eigenes Framework) + MCP-Server
- Rolle: `orchestrator` — AI-Orchestrator für Instanzen 2–7
- **MoA-Stack (DIVERSE Modelle, NICHT nur Qwen) — alles fest vorgeladen, ~25 GB VRAM:**

  | Modell | Größe | Aufgabe | Warum gerade das | VRAM |
  |--------|-------|---------|-----------------|------|
  | **1. Mistral-Small-3.1 8B** | 8B | Haupt-Pipeline-Planer, Tool-Calling | Mistral ist der Goldstandard für Agent-Arbeit, strukturiert besser, präzisere Tool-Calls als Qwen | ~8 GB FP8 |
  | **2. Qwen3-4B** | 4B | Schnell-Klassifizierer, einfache Entscheidungen | Kleinstes schnellstes Modell für triviale Aufgaben ("ist das Audio oder Visual?") | ~4 GB FP8 |
  | **3. Gemma 3 7B** | 7B | Audio-Prompt-Formulierung, Musik-Beschreibungen | Google-Modell, andere Trainingsdaten, besser bei kreativen Text-Beschreibungen für Musik-Prompts | ~7 GB FP8 |
  | **4. Llama 3.2 3B Instruct** | 3B | Visual-Prompt-Optimierung, Stil-Matching | Meta-Modell, andere Perspektive, sehr gut bei visuellen Beschreibungen | ~3 GB FP8 |

  → 4 Modelle von 4 verschiedenen Anbietern (Mistral, Qwen, Google, Meta)
  → Diversität = MoA gewinnt durch unterschiedliche Blickwinkel
  → Gesamt: ~22 GB → 26 GB Puffer auf A6000

- **MoA-Architektur (3 Schichten):**
  1. **Classifier (Qwen3-4B)** — was für eine Aufgabe? Audio? Visual? Beides? Welche Instanzen werden benötigt?
  2. **Planner (Mistral-Small-3.1 8B + Gemma 3 7B parallel)** — beide erstellen unabhängig einen Pipeline-Plan
  3. **Aggregator (Mistral-Small-3.1 8B)** — vergleicht beide Pläne, wählt den besseren, erstellt den finalen Ablauf
- **MCP-Clients** — jede der 6 Spezial-Instanzen ist ein Tool:
  - `ears.analyze` / `ears.transcribe` / `ears.embed`
  - `voice.tts` / `voice.stem_separate` / `voice.sfx`
  - `music.generate` / `music.remix` / `music.drop`
  - `image.generate` / `image.reference`
  - `video.real.generate` / `video.abstract.generate`
- **Zusätzliche Komponenten (im System-RAM / GPU-Nebenzeit):**
  - Text-Embedding: `BGE-M3` (~2 GB)
  - Audio-Embedding-Cache (Ergebnisse von Ears wiederverwenden)
  - CLIP-Bild-Embedding (~2 GB) für Stil-Matching
  - Agent-Framework (LangGraph oder eigenes)
- Aufgaben:
  - Nimmt komplexe Multimodal-Aufträge von Brain entgegen
  - Orchestriert Instanzen 2–7 vollautomatisch
  - Baut Pipelines aus mehreren KI-Schritten zusammen
  - Qualitätsprüfung der Ergebnisse zwischen den Schritten
  - Gibt fertige Pakete zurück (Track + Stems + Visuals + Metadaten)
- Idle-Timeout: 900 s

---

## Cross-Cutting Systeme

### AutoDJ / AutoMixer
- Nutzt Ears (BPM/Key/Genre/Energie) + regelbasierte Mixing-Engine lokal im Audio-Backend.
- Brain plant bei Bedarf die Mischung und gibt Empfehlungen.
- Das eigentliche Mixen (EQ, Filter, Crossfader) läuft LOKAL im Audio-Engine-Worklet, nicht auf RunPod — zu wichtig für niedrige Latenz.

- dropMONK:
  - Brain erstellt Konzept & Struktur (Drop-Länge, Energie, Timing).
  - Ears erkennt BPM, Key, freie Stelle, Drop-Punkt im bestehenden Track.
  - Music generiert den Drop selbst (oder passende Elemente).
  - Voice liefert SFX / Percussion / Effekte dazu (Stable Audio).
  - Keine Sprachausgabe nötig – dropMONK ist kein MC, es baut Drops.
  - Lokale Audio-Engine fügt alles beatgenau ein und speichert als Asset.

### Visual-Choreographie-System
- Eingang: Track + Metadaten (von Ears)
- Brain erstellt Timeline: Abschnitt → Stil + Farbe + Intensität
- Instanz 5 erzeugt Keyframes pro Abschnitt
- Instanz 6 erzeugt Loops + Übergänge
- Ausgabe geht an das Visualizer-Plugin im Frontend
- Assets werden in `visual-assets/` gespeichert

### Asset-Verzeichnis-Struktur
```
visual-assets/
├── loops/        # Beat-sync Loops (nach Stil/BPM sortiert)
├── drops/        # Drop-Animationen (kurz, intensiv)
├── textures/     # Abstrakte Texturen & Stills
├── fx/           # Einzel-Effekte (Glitch, Licht, Partikel)
├── keyframes/    # Keyframes pro Abschnitt / Track
└── uploads/      # User-Uploads zur Weiterverarbeitung
```

---

## Kosten (grob)
- 6 × A6000 Community → ~2,40 €/h im Volllastbetrieb
- Bei max. 10 h/Monat Betrieb: ~24 €/Monat
- scale-to-zero (workersMin=0): 0 € wenn nicht genutzt

## Offene Entscheidungen / nächste Schritte
- [ ] Brain final: bleibt 14B-AWQ oder auf 30B-A3B upgraden? (aktuell: 14B ist guter Kompromiss)
- [ ] Voice: Qwen VoiceDesign wirklich in Preload oder reicht CustomVoice + on-demand VoiceDesign?
- [ ] Music: ACE-Step XL Turbo oder base + SFT? (aktuell: XL Turbo für höchste Qualität)
- [ ] Visual Image: FLUX.2 [dev] Lizenz klären (kommerzielle Nutzung braucht BFL-Lizenz) → Alternative: Qwen-Image-2512 (Apache 2.0) als Fallback
- [ ] Visual Video: Wan 2.2 + LTXVideo beide auf einer A6000 im Wechsel oder jede Instanz ein festes Modell?
- [ ] Deployment-Reihenfolge festlegen
