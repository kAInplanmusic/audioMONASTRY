# AI-Flotte neu: 6 × 48 GB, alles resident, ≤ 4 €/h (Entwurf 2026-10-07)

Auftrag Betreiber: neue Bestandsaufnahme mit 48-GB-Instanzen. Die drei
Visual-Rollen (imageHq, videoReal, videoAbstract) sind überholt. Bei „AI an"
liegen **alle** Modelle dauerhaft im VRAM, kein Nachladen, kein Tausch, keine
lokalen oder API-Fallbacks. Zahlen im Code: `src/config/aiInfrastructure.ts`
(`AI_RESIDENT_FLEET`), Gate: `tests/aiResidentFleet.test.ts`.
Dieses Dokument ist ein **Entwurf**; verbindlich wird es erst in
`docs/INFRA_KONSTITUTION.md` nach Freigabe (siehe §5).

## 1. Befund zum Preis (wichtigste Korrektur)

Die „~0,49 €/h je 48-GB-Instanz" im Code gilt für **Pods**, nicht für Serverless.
RunPod-Preisliste (runpod.io/pricing, 2026-10-07):

| 48 GB | Pod (Secure) | Serverless Flex |
|---|---|---|
| A40 | 0,49 $/h | 1,22 $/h |
| RTX A6000 | 0,53 $/h | 1,22 $/h |
| L40S | 1,09 $/h | 1,75 $/h |

6 dauerhaft laufende Instanzen: **Pod A6000 2,93 €/h**, Pod A40 2,70 €/h,
**Serverless Flex 6,73 €/h (reißt die 4 €)**. Für 4 €/h passen als Pod 8
Instanzen, als Serverless nur 3. „Immer alles resident" ist daher nur mit
**Pods** (App startet/beendet sie mit dem AI-Schalter) bezahlbar.
Offen und nicht geprüft: Rabatt für Serverless-Active-Worker.

## 2. Modelle: alt → neu (geprüft an den Hugging-Face-Modellkarten)

| Rolle | Alt | Neu | Warum / Lizenz |
|---|---|---|---|
| Brain (DAW per Text, Tool-Calls) | Qwen3-30B-A3B-AWQ + 4B/8B-MoA-Orchestrator | **Qwen3.6-35B-A3B (FP8)** | Neuer (15.04.2026), Apache-2.0, nur 3B aktiv = schnell. Der MoA-Orchestrator entfällt, die Agentenschleife liegt in `MoaAgent` (App). FP8-Repo existiert; ~36 GB, bleiben ~6 GB für KV-Cache, **Int4 als Rückfall prüfen** |
| Ears (Analyse) | Qwen2-Audio-7B, MERT | **MOSS-Audio-8B-Thinking** | Neuer (09/2026), Apache-2.0, Musikverständnis (Akkord/Tonart/Tempo laut Projekt). **MERT entfällt** (CC-BY-NC-SA, nicht kommerziell). Messwerte (BPM, Tonart, Lautheit, Takt) bleiben DSP (essentia, CPU), das LLM erklärt nur |
| Stems | HTDemucs 6s | **bleibt**; BS-RoFormer = Kandidat | BS-RoFormer ~+2 dB Gesang-SDR (Sekundärquelle), im Repo aber nur Stub, erst auf GPU belegen |
| Speech | Qwen3-TTS 1.7B (CustomVoice + VoiceDesign) | **bleibt** | Apache-2.0, 16,5 Mio. Downloads |
| SFX | Stable Audio Open 1.0 | **bleibt vorerst** | Gated + Umsatzgrenze (Lizenz prüfen). Kandidat „Stable Audio 3" (arXiv 2605.17991), Gewichte nicht geprüft |
| Musik / Remix / Drop | ACE-Step 1.5 XL base+sft+turbo + LM-4B | **sft + turbo + LM-4B** | MIT. `base` entfällt (−9 GB). Cover/Repaint/Extract decken Remix und Übergänge ab |
| Bild | FLUX.1-dev + Qwen-Image-2512 + IP-Adapter + 15 Stil-LoRAs | **Qwen-Image-Edit-2511 + SDXL 1.0** (+ ControlNet depth/canny, Real-ESRGAN) | Edit-Modell (Apache-2.0, 20B) baut vorhandene Bilder um, Mehrbild-Referenz ersetzt den IP-Adapter. SDXL bleibt, weil darauf die **32 fertig trainierten Themen-LoRAs** laufen (openrail++, kommerziell sauber). FLUX.1-dev entfällt (nicht kommerziell) |
| Video | Wan 2.2 **T2V** (Real) + LTX 13B (Abstract), zwei Instanzen | **LTX-2.3 22B (distilled, FP8)** + RIFE + Real-ESRGAN, eine Instanz | I2V, V2V und **Audio-to-Video** in einem Modell (Update 02.10.2026). Lizenz „ltx-2-community" (Umsatzgrenze, **vor Kommerz prüfen**). Lizenzsauberer Ersatz: Wan 2.2 I2V-A14B (Apache), passt aber nicht zusammen mit LTX in 42 GB |

Gefunden: `videoReal` hatte 41 GB Preload auf einer 24-GB-Karte (18 GB nutzbar),
passte also nie resident. Mit 48 GB und einem Modell ist das gelöst.

## 3. Belegung (nutzbar je Karte: 48 − 6 Marge = 42 GB)

| # | Instanz | Modelle | Summe |
|---|---|---|---|
| 1 | brain | Qwen3.6-35B-A3B FP8 | 36 |
| 2 | ears | Whisper-v3, CLAP, MOSS-Audio-8B, pyannote, AST, essentia (CPU) | 33 |
| 3 | voice | Qwen3-TTS ×2, HTDemucs-6s, Stable Audio Open | 34 |
| 4 | music | ACE-Step sft, turbo, LM-4B | 26 |
| 5 | image | Qwen-Image-Edit-2511 (inkl. Textencoder), SDXL 1.0, ControlNet depth + canny, Real-ESRGAN | 40 |
| 6 | video | LTX-2.3 distilled (inkl. Textencoder), RIFE, Real-ESRGAN | 37 |

Mehr als 6 Instanzen nötig? Nein; weniger geht nicht (ears+voice = 67 GB usw.).
**Schätzwerte** für die neuen Modelle (brain, MOSS, Qwen-Image-Edit, LTX) kommen
aus Parameterzahl × Bytes, nicht aus Messung. Bild (40 GB), Video (37 GB + Aktivierungen)
und brain (KV-Cache) sind die engsten Stellen und **müssen auf der echten Karte
gemessen werden**, bevor die Zahlen verbindlich werden.

## 3a. Visuals: was in den alten Instanzen geplant war und wie es übernommen wird

Quellen: `runpod-8-instances-complete-plan.md` §5–7, `VISUAL_LORA_STACK.md`,
`VISUALMONK_SPEC.md`, `VISUALVORLAGEN.md`.

| Alt (Zweck) | Neu | Stand |
|---|---|---|
| FLUX.1-dev: Fotorealismus, LoRA-Trainingsbasis | entfällt (nicht kommerziell). Realismus über Qwen-Image-Edit; Training läuft auf SDXL | ersetzt |
| Qwen-Image-2512: Illustration, Comic, Textur | **Qwen-Image-Edit-2511** (gleiche Familie, Apache) | ersetzt |
| SDXL 1.0 + 32 Themen-LoRAs (8,44 $ trainiert, 2,7 GB) | **bleibt resident** als Stil-Motor | übernommen |
| 15 Stil-LoRAs je Instanz (Cyberpunk, Glitch, Fraktal, Horror ...) | LoRAs liegen auf dem Volume und werden je Job über die `LoraLoader`-Kette eingehängt (`comfyui_adapter.py`). Das tauscht kein Basismodell, ist also mit „alles resident" vereinbar | übernommen |
| ControlNet depth/canny (Bild) | bleiben für SDXL (Manifest) | übernommen |
| IP-Adapter (Stil aus Referenzbild, Serien) | ersetzt durch Mehrbild-Referenz in Qwen-Image-Edit | ersetzt, **Qualität prüfen** |
| Real-ESRGAN 4x (Bild, Video) | bleiben | übernommen |
| Wan 2.2 A14B (real) + LTX 13B (abstrakt) | **LTX-2.3** für beides; „real" vs. „abstrakt" über LoRA/Prompt | zusammengelegt, **Qualität real prüfen** |
| RIFE 4x (24 → 60 fps Loops) | bleibt | übernommen |
| ControlNet depth/canny + IP-Adapter für Video | entfallen (waren Wan-/LTX-13B-spezifisch). Für LTX-2.3 Struktur-Steuerung (IC-LoRA/First-Last-Frame) **nicht geprüft** | **Lücke** |
| Modi T2I, I2I, Referenz→Serie, T2V, I2V, Diashow→Video, V2V | alle abgedeckt; neu dazu **Audio→Video** | verbessert |
| Aufgaben: Keyframes je Trackabschnitt, Drop-Animationen, VJ-Loops, Übergänge | unverändert; Pipeline `ears → brain → image → video` bleibt (`VISUALMONK_SPEC.md` §4) | übernommen |
| Clip-Bank statt Live-Erzeugung (3-s-Clip = 101–162 s mit Wan-5B, gemessen) | bleibt als Prinzip: Erzeugung läuft einen Clip voraus, nie im Takt. LTX-distilled (8 Schritte) dürfte schneller sein, **ungemessen** | Prinzip übernommen |
| 15 GB Reserve auf der Bild-Instanz für LoRA-Training | entfällt: Training läuft ohnehin auf einem eigenen Pod (L40S, gemessen 2026-09-24) und zählt nicht zu den 4 €/h | gestrichen |
| Live-Shader (WebGPU) + Ghostuser 6 | unberührt, läuft im Client | unberührt |

Gemessene Abweichung der Realität vom alten Plan: deployt war für Video
**Wan 2.2 TI2V-5B** (nicht A14B), und die 24-GB-Karte konnte A14B ohnehin nicht
tragen.

## 4. Hochrechnung (6 Instanzen, Pod A6000 = 2,93 €/h)

| Nutzung pro Monat | Kosten GPU |
|---|---|
| 10 h | 29 € |
| 40 h | 117 € |
| 100 h | 293 € |
| 24/7 (720 h) | 2.109 € |

- Puffer zur 4-€-Grenze: 1,07 €/h (27 %) mit A6000, 1,30 €/h mit A40.
- **Speicher:** ~194 GB Gewichte ≈ 200 GB Network-Volume ≈ 14 $/Monat (0,07 $/GB)
  ≈ **13 €/Monat**. Die Konstitution erlaubt 5 €/Monat → **Widerspruch**.
- **Start:** Pod-Start + 30–36 GB aus dem Volume in den VRAM, grob 2–5 Minuten
  (Schätzung, ungemessen). Die 6 Instanzen starten parallel. Ein gestoppter Pod
  bekommt nicht garantiert dieselbe GPU zurück; sicherer ist Neu-Deploy aus
  Template + Volume (zu verifizieren).

## 5. Entscheidungen, die bei dir liegen

1. **Pods statt Serverless** für die Flotte (Voraussetzung für 4 €/h).
2. **Speicherbudget** 5 → ~13 €/Monat anheben oder Gewichte verkleinern.
3. **Video:** LTX-2.3 (Audio-to-Video, Lizenzprüfung) oder Wan 2.2 I2V (Apache, ohne Audio-Bezug). Dazu: genügt LTX auch für „realistisch", oder soll Wan-5B (gemessen, Apache) als Foto-Clip-Motor erhalten bleiben (würde eine 7. Instanz ≈ +0,5 €/h bedeuten, gesamt ≈ 3,4 €/h)?
4. **Migration 8 → 6 Rollen** freigeben. Sie berührt ~30 Dateien (Endpoint-Registry,
   `runpod-deploy.py`, Warm-/Smoke-Skripte, aiGate, Tests, `RP_ENDPOINT_ID_*`).
   Bis dahin laufen die 8 Rollen unverändert; im Code ist nur das Zielbild + Gate ergänzt.

Neue Modelle brauchen vor dem Einsatz Manifest-Einträge mit gepinnter Revision
und Lizenzprüfung (`status: 'neu'` in `AI_RESIDENT_FLEET`).

## Quellen

- RunPod-Preise: https://www.runpod.io/pricing
- https://huggingface.co/Qwen/Qwen3.6-35B-A3B · https://huggingface.co/Qwen/Qwen-Image-Edit-2511
- https://huggingface.co/Lightricks/LTX-2.3 · https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B
- https://huggingface.co/OpenMOSS-Team/MOSS-Audio-8B-Thinking · https://huggingface.co/ACE-Step/Ace-Step1.5
- https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
