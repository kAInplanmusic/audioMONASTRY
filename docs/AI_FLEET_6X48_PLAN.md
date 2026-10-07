# AI-Flotte neu: 4 × 48 GB, alles resident, ohne Visual-Generierung (Entwurf 2026-10-07)

Auftrag Betreiber: AI-Aufpreis max. 4 €/h, 48-GB-Instanzen (5–6 wären möglich),
bei „AI an" liegen **alle** Modelle dauerhaft im VRAM (Laden beim App-Start,
danach kein Nachladen, kein Tausch), keine lokalen oder API-Fallbacks.
**Visuals entstehen aus vorhandenen Bildern und Videos, nicht aus KI-Generierung:**
die drei Visual-Rollen (imageHq, videoReal, videoAbstract) bekommen keine GPU
mehr. Zahlen im Code: `src/config/aiInfrastructure.ts` (`AI_RESIDENT_FLEET`),
Gate: `tests/aiResidentFleet.test.ts`, Resident-Modus: `AI_RESIDENT_ONLY=1`.
Entwurf; verbindlich wird es erst in `docs/INFRA_KONSTITUTION.md` (siehe §5).

## 1. Befund zum Preis

Die „~0,49 €/h je 48-GB-Instanz" im Code gilt für **Pods**, nicht für Serverless
(runpod.io/pricing, 2026-10-07):

| 48 GB | Pod (Secure) | Serverless Flex |
|---|---|---|
| A40 | 0,49 $/h | 1,22 $/h |
| RTX A6000 | 0,53 $/h | 1,22 $/h |
| L40S | 1,09 $/h | 1,75 $/h |

4 dauerhaft laufende Instanzen: **Pod A6000 1,95 €/h**, Pod A40 1,80 €/h,
**Serverless Flex 4,49 €/h (knapp über 4 €)**. Als Pod passen 8 Instanzen ins
Budget, als Serverless nur 3. „Immer alles resident" ist daher mit **Pods**
(App startet/beendet sie mit dem AI-Schalter) sicher bezahlbar. Rabatt für
Serverless-Active-Worker: nicht geprüft.

## 2. Modelle (geprüft an den Hugging-Face-Modellkarten)

| Rolle | Alt | Neu | Warum / Lizenz |
|---|---|---|---|
| Brain (DAW per Text, Tool-Calls) | Qwen3-30B-A3B-AWQ + 4B/8B-MoA-Orchestrator | **Qwen3.6-35B-A3B (FP8)** | Neuer (15.04.2026), Apache-2.0, nur 3B aktiv = schnell. MoA-Orchestrator entfällt, die Agentenschleife liegt in `MoaAgent` (App). ~36 GB, bleiben ~6 GB KV-Cache, **Int4 als Rückfall prüfen** |
| Ears (Analyse) | Qwen2-Audio-7B, MERT | **MOSS-Audio-8B-Thinking** | Neuer (09/2026), Apache-2.0, Musikverständnis. **MERT entfällt** (CC-BY-NC-SA). Messwerte (BPM, Tonart, Lautheit, Takt) bleiben DSP (essentia, CPU), das LLM erklärt nur |
| Stems | HTDemucs 6s | **bleibt**; BS-RoFormer = Kandidat | BS-RoFormer ~+2 dB Gesang-SDR (Sekundärquelle), im Repo nur Stub, erst auf GPU belegen |
| Speech | Qwen3-TTS 1.7B (CustomVoice + VoiceDesign) | **bleibt** | Apache-2.0, 16,5 Mio. Downloads |
| SFX | Stable Audio Open 1.0 | **bleibt vorerst** | Gated + Umsatzgrenze (Lizenz prüfen). Kandidat „Stable Audio 3" (arXiv 2605.17991), Gewichte nicht geprüft |
| Musik / Remix / Drop | ACE-Step 1.5 XL base+sft+turbo + LM-4B | **sft + turbo + LM-4B** | MIT. `base` entfällt (−9 GB). Cover/Repaint/Extract decken Remix und Übergänge ab |
| Bild / Video | FLUX.1-dev, Qwen-Image, Wan 2.2, LTX 13B (3 Instanzen) | **entfällt** | Visuals aus vorhandenem Material, siehe §3a |

## 3. Belegung (nutzbar je Karte: 48 − 6 Marge = 42 GB)

| # | Instanz | Modelle | Summe |
|---|---|---|---|
| 1 | brain (+ Orchestrator) | Qwen3.6-35B-A3B FP8 | 36 |
| 2 | ears | Whisper-v3, CLAP, MOSS-Audio-8B, pyannote, AST, CLIP ViT-L/14, essentia (CPU) | 35 |
| 3 | voice | Qwen3-TTS ×2, HTDemucs-6s, Stable Audio Open | 34 |
| 4 | music | ACE-Step sft, turbo, LM-4B | 26 |

4 Instanzen genügen und lassen Puffer; bis 6 wären im Budget (z. B. eine
eigene Stem-Instanz, damit lange Song-Trennungen die Sprachausgabe nicht
blockieren). Mehr ist kein Ziel („keine Aufblähung").
Die Werte der neuen Modelle (brain, MOSS) sind **Schätzungen** aus
Parameterzahl × Bytes; brain (KV-Cache) ist die engste Stelle und **muss auf der
echten Karte gemessen werden**.

## 3a. Visuals ohne GPU-Generierung

Was in den alten drei Visual-Instanzen geplant war (`runpod-8-instances-complete-plan.md`
§5–7, `VISUAL_LORA_STACK.md`, `VISUALMONK_SPEC.md`, `VISUALVORLAGEN.md`) und was
davon ohne Diffusion übrig bleibt:

| Alt (Zweck) | Neu |
|---|---|
| Keyframes je Trackabschnitt (Intro/Build/Drop/Breakdown) | **Auswahl** passender Bilder/Videos aus dem eigenen Bestand je Abschnitt |
| Audio → Prompt → Bild/Clip (`ears → brain → vision`) | `ears` (CLAP/AST) liefert Beschreibung + Embedding, `brain` formuliert die Abfrage, **CLIP-Embeddings** (`clip-vit-l14`, 768-dim, Tabelle `visual_embeddings` existiert) finden das passende Material |
| Clip-Bank, Auswahl nach Audio-Features, Schnitt/Übergang live (`VISUALVORLAGEN.md`) | bleibt: `onset` = Schnitt, `energy` = Gruppenwahl, `bass` = Zoom-Puls, `treble` = Farbdrift, `mid` = Kreuzblende. Die Bank besteht aus vorhandenem Material |
| Stil-LoRAs, Themen-LoRAs, Stil-Transfer, ControlNet, IP-Adapter | entfallen auf der GPU. Looks kommen aus Shadern (WebGPU, 12 Presets) und ffmpeg-Filtern |
| RIFE, Real-ESRGAN (Interpolation, Hochskalieren) | entfallen auf der GPU; falls nötig ffmpeg auf dem media-Knoten (Hetzner) |
| Show-Orchestrator (`showOrchestrator.ts`), Merge zu einem mp4 (ffmpeg) | unberührt |
| Echtzeit-Shader, Ghostuser 6 (`/visual-out`) | unberührt, läuft im Client |
| Selbstlern-Loop (Bewertung → Kuratierung) | bleibt als Bewertung des **Auswahlverhaltens**; LoRA-Training entfällt |

Bereits trainierte Assets (32 SDXL-Themen-LoRAs, 8,44 $; erzeugte Clip-Vorlagen)
bleiben im Speicher, werden aber nicht mehr bedient. Das CLIP-Modell ist das
**einzige** visuell verwandte Modell und nur zum Wiederfinden; es lässt sich
ohne Folgen streichen (−2 GB).

## 4. Hochrechnung (4 Instanzen, Pod A6000 = 1,95 €/h)

| Nutzung pro Monat | Kosten GPU |
|---|---|
| 10 h | 20 € |
| 40 h | 78 € |
| 100 h | 195 € |
| 24/7 (720 h) | 1.404 € |

- Puffer zur 4-€-Grenze: 2,05 €/h (51 %) mit A6000, 2,20 €/h mit A40.
- **Speicher:** ~131 GB Gewichte ≈ 135 GB Network-Volume ≈ 9,5 $/Monat (0,07 $/GB)
  ≈ **8,7 €/Monat**. Die Konstitution erlaubt 5 €/Monat → **Widerspruch**
  (kleiner, aber vorhanden).
- **Start:** Pod-Start + 26–36 GB je Instanz aus dem Volume in den VRAM, grob
  2–4 Minuten (Schätzung, ungemessen), alle Instanzen parallel. Ein gestoppter
  Pod bekommt nicht garantiert dieselbe GPU zurück; sicherer ist Neu-Deploy aus
  Template + Volume (zu verifizieren).

## 5. Entscheidungen, die bei dir liegen

1. **Pods statt Serverless** für die Flotte (Serverless wäre bei 4 Instanzen mit 4,49 €/h knapp über der Grenze).
2. **Speicherbudget** 5 → ~9 €/Monat anheben oder Gewichte verkleinern.
3. **Instanzzahl:** 4 (empfohlen) oder bis 6 (z. B. eigene Stem-Instanz).
4. **Migration 8 → 4 Rollen** freigeben (die drei Visual-Rollen entfallen). Sie
   berührt ~30 Dateien (Endpoint-Registry, `runpod-deploy.py`, Warm-/Smoke-Skripte,
   aiGate inkl. Modus „mit Visuals", `runpodVision.ts`, Tests, `RP_ENDPOINT_ID_*`).
   Bis dahin laufen die 8 Rollen unverändert; im Code sind nur Zielbild, Gate und
   der Resident-Modus ergänzt.

Neue Modelle brauchen vor dem Einsatz Manifest-Einträge mit gepinnter Revision
und Lizenzprüfung (`status: 'neu'` in `AI_RESIDENT_FLEET`).

## Quellen

- RunPod-Preise: https://www.runpod.io/pricing
- https://huggingface.co/Qwen/Qwen3.6-35B-A3B · https://huggingface.co/OpenMOSS-Team/MOSS-Audio-8B-Thinking
- https://huggingface.co/ACE-Step/Ace-Step1.5 · https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
