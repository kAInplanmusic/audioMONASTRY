# VisualMONK · Echtzeit-Visualisierung + generative Bilder/Video (Spezifikation)

> Status: **Slice 1 umgesetzt** (visual-Kern + Budget-Guards + Vision-Endpoint live).
> Stand: 2026-09-11 · Autor: Systemarchitekt · Kanonische Ausführungsliste bleibt `MASTER_TODO.md`.

Diese Spec beschreibt das Subsystem **VisualMONK**: eine **live audio-reaktive
Visualisierung**, die die App als eigenen Stream an einen **Ghostuser 6** (Beamer)
sendet — analog zum Master-Sound-Stream an **Ghostuser 5** (Soundsystem) — plus
**generative Bilder/Video** aus Text **und** Ton, mit Selbstlern-Loop.

---

## 1. Grundprinzip: zwei getrennte Welten

| | **A) Echtzeit-Liveshow** | **B) Generative Einzelbilder/Video** |
|---|---|---|
| Technik | **Shader** (WebGPU/WGSL, WebGL-Fallback) | **Diffusion** auf RunPod |
| Latenz | 60 fps, sofort | 1–5 s (Bild), 10 s–Minuten (Video) |
| Kosten | 0 (Client-GPU) | nur bei Generierung, scale-to-zero |
| Inhalt | Fraktale, Plasma, Partikel, Galaxien, Wasser/Feuer/Gewitter, Geometrie, Farbverläufe, Kaleidoskop/psychedelisch | Malstile, Noir, Comic, Realismus, Dystopie, Alien, unmögliche Szenerien |
| Steuerung | Audio-Features (BPM/Onset/Bänder) direkt auf Shader-Parameter | Prompt + Audio-Embedding + Stil/LoRA + Bildupload (IP-Adapter/ControlNet) |

**Kein Widerspruch:** die Liveshow liefert die flüssige Projektion auf den Beamer;
die generative KI liefert das „Kunstwerk"/den Clip, das die Show einblenden kann.

## 2. Transport: Ghostuser 5 (Ton) und Ghostuser 6 (Visuals)

Es gibt (noch) keinen Ghost-User im Code — er wird als **headless Viewer** eingeführt:

```
Studio-Session (App)
  ├── Master-Audio → MediaStreamAudioDestinationNode ─────────► Ghostuser 5  (fixe URL, Soundsystem)
  └── Visual-Canvas → canvas.captureStream(30) ────┐
                                                   ├─ WebRTC/SFU ─► Ghostuser 6 (fixe URL, Beamer)
  Audio-Features (FFT/RMS/Onset) ──► Visual-Params ─┘
```

- **Ghost-Client:** eigener, headless Client (`/ghost/5` = Audio-Playback, `/ghost/6` =
  Fullscreen-Canvas), der der Session per fixer URL beitritt, auto-Play/Fullscreen,
  Reconnect-fähig. Kein UI, kein Mikro/keine Frequenzanalyse nötig.
- Der Visual-Stream ist **kein** neuer Medienkanal im Datenmodell, sondern ein
  weiterer Track im bestehenden WebRTC/SFU-Pfad (wie der Master-Sound-Track).
- Fallback ohne SFU: MJPEG/WebP über WebSocket oder HLS-Frames.

## 3. Audio-Feature-Bus

Ein zentraler Bus liefert **einmal pro Frame** normalisierte Features:

```ts
interface AudioFeatures { bass; mid; treble; rms; onset; energy; bpm }  // alle 0..1 außer bpm
```

Quelle: Analyser-/Worklet-Tap am Master (nicht am AudioWorklet-Thread rechnen →
Anforderung „Audio-Thread bleibt frei“). Mapping → `VisualParams` ist bereits als
**reiner, getesteter Kern** umgesetzt: `src/core/visual/audioReactive.ts`
(`mapAudioToParams`, `blendParams`, `normalizeFeatures`), Presets in
`src/core/visual/visualPresets.ts` (12 Stile).

## 4. Rolle `vision` (generativ)

- **4. Endpoint** der Flotte (`samplemonk-ai-vision`), A6000 48 GB, `workers 0..1`,
  `idle=15 min`, scale-to-zero → **~0,49 €/h nur bei Generierung**.
- **Live-Versuch 2026-09-11:** Hub-Worker `runpod-workers/worker-sdxl-turbo` (v1.1.1)
  angelegt (Endpoint `5eiw6t03hjln9x`, A40/A6000) — der Worker laedt zwar, **verwirft aber
  jeden Job** (`ERROR | Error while getting job: 'NoneType' object has no attribute 'get'`).
  Das ist das bekannte „kaputter Hub-Worker“-Muster: alter Job-Contract, nicht abwarten.
  Endpoint wieder **geloescht** (Kosten), Ersatz gewaehlt:
  **`PrunaAI/runpod-worker-FLUX.1-dev` 1.0.3** (2025-07-18, GPU-Pool `AMPERE_48` = unser
  A6000, 80 GB Disk) bzw. als schlanke Alternative `runpod-workers/worker-sdxl` 2.1.1.
- **Naechster Schritt:** Ersatz-Worker deployen (Kaltstart 15–25 min Bild-Pull) und mit
  `scripts/runpod-vision-test.py` ein echtes Bild ziehen.
- **Tasks:** `image.generate` (Text→Bild), `image.style` (Bildupload→Stil via
  IP-Adapter/ControlNet), `video.generate` (leichtes Modell), `video.audioReactive`.
- **Upgrade-Pfad:** FLUX.1-schnell (Apache-2.0) für Realismus; ein zweiter Satz
  Stil-LoRAs (Noir/Comic/Dystopie/psychedelisch) — pro Stil ein LoRA.
- **Audio→Prompt:** `ears` (CLAP/AST/Whisper/Essentia) erzeugt Beschreibung/
  Embedding; `brain` formuliert den Bild-Prompt; `vision` rendert.

## 5. Datenbank & Selbstlern-Loop

pgvector (Supabase) existiert. Neue Tabellen:

| Tabelle | Inhalt |
|---|---|
| `visual_presets` | Stil-Presets (shader) + Prompt-Vorlagen |
| `visual_generations` | Prompt, Modell, Seed, Params, R2-URL, Session/Track-Bezug |
| `visual_embeddings` | CLIP-Bildembeddings (`vector(768)`) für Ähnlichkeit |
| `visual_feedback` | Bewertung der Nutzer **nach Session-Ende** |

**Loop (ehrlich, nicht „magisch"):**
1. Nach Session-Ende fragt die App **alle User** (abschaltbar): „Welche Visuals
   waren die krassesten?" (Skala + Tags).
2. Bestbewertete Paare (Prompt/Bild) werden kuratiert.
3. **Stil-LoRA-Training** auf einem RunPod-**Pod** (nicht Serverless) aus dem Katalog.
4. bessere Prompts/Params per **Preference-Loop** (Bandit über Stil-Parameter).
5. **RAG**: ähnliche Prompts/Stile via `visual_embeddings` vorschlagen.

## 6. Settings & Schalter

- Master-Schalter **„Visualisierung"** (Einstellungen) → aus, wenn kein
  Abspielgerät vorhanden ist (kein Visual-Stream, kein Ghostuser 6).
- Preset-Auswahl, Intensität, „audio-reaktiv: aus/an", Ghost-URLs für 5/6.
- Auto-aus bei fehlendem Beamer (kein Ghost-6-Client verbunden) nach Timeout.

## 7. Budgets (Betreiber-Vorgabe 2026-09-11)

In `src/config/aiInfrastructure.ts` als Guards hinterlegt und getestet:

| Grenze | Wert | Guard |
|---|---|---|
| GPU-Endpoints | max **4** (inkl. `vision`) | `assertGpuEndpointBudget()` |
| Flotte pro Stunde | max **10 €/h** | `assertFleetHourlyBudget()` |
| Speicher/Snapshots | max **5 €/Monat** (Hetzner + RunPod) | `assertStorageBudget()` |

Erfahrungswerte: brain/ears/voiceGen/vision je **0,49 €/h** (A6000) → 4 Rollen ≈
**1,96 €/h**; mit 5 Hetzner-Instanzen bleibt die Flotte unter 10 €/h.

## 8. Arbeitspakete (Slices)

1. **DONE** visual-Kern (Presets + Audio→Visual, getestet) · Budget-Guards ·
   Vision-Endpoint live (`samplemonk-ai-vision`).
2. **NEXT** Renderer (WebGPU mit WebGL-Fallback) + `VisualTerminal`-UI +
   Settings-Toggle + Feature-Bus am Master-Tap.
3. **NEXT** Ghost-Clients `/ghost/5` (Audio) und `/ghost/6` (Visual) + Stream
   über den bestehenden SFU-Track; Fallback MJPEG.
4. Vision-Pipeline: Text→Bild + Audio→Prompt; R2-Ablage; DB-Eintrag.
5. Video (LTX-Video/Wan2.1) + Zusammenführen von Clips.
6. Selbstlern-Loop + Session-Ende-Umfrage + pgvector/RAG + LoRA-Pods.
7. `vision` in Deploy-Skript/Registry als benanntes Template festigen
   (Endpoints-Hub-Inline-Template → **benanntes** Template, siehe Befund F-015).

## 9. Risiken / ehrliche Grenzen

- Diffusion ist **kein** Live-Stream — Projektion muss die Liveshow (Shader) sein.
- Ein 14B-LLM (vLLM, 90 % VRAM) + Diffusionsmodell auf **einer** Karte konkurrieren
  → eigener `vision`-Endpoint ist Pflicht.
- AWQ-/Stil-LoRA-Qualität: Stile sind Geschmack; Lizenz je Modell/LoRA prüfen
  (einige NC-Gewichte → privat).
- Ghost-User braucht **stabile Netze/Reconnect** (Beamer im Club-WLAN).
