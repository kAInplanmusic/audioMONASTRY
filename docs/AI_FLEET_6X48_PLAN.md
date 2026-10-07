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
| SFX / Geräusche | Stable Audio Open 1.0 | **MOSS-SoundEffect-v2.0** | Apache-2.0, 1,3B, 48 kHz, bis 30 s je Aufruf, Umwelt/Urban/Kreatur/Handlung + kurze perkussive Clips (HF-Modellkarte). Stable Audio Open war gegatet mit Umsatzgrenze. **Stable Audio 3 medium** (2B, Musik + SFX + Inpainting, Minuten) ist stärker, aber „Community License" = nur nicht-kommerziell, kommerziell separate Lizenz → nicht aufgenommen. Qualität gegen SAO ungehört, erst vergleichen |
| Musik / Remix / Drop | ACE-Step 1.5 XL base+sft+turbo + LM-4B | **sft + turbo + LM-4B** | MIT. `base` entfällt (−9 GB). Cover/Repaint/Extract decken Remix und Übergänge ab |
| Bild / Video | FLUX.1-dev, Qwen-Image, Wan 2.2, LTX 13B (3 Instanzen) | **entfällt** | Visuals aus vorhandenem Material, siehe §3a |

## 3. Belegung (nutzbar je Karte: 48 − 6 Marge = 42 GB)

| # | Instanz | Modelle | Summe |
|---|---|---|---|
| 1 | brain (+ Orchestrator) | Qwen3.6-35B-A3B FP8 | 36 |
| 2 | ears | Whisper-v3, CLAP, MOSS-Audio-8B, pyannote, AST, CLIP ViT-L/14, essentia (CPU) | 35 |
| 3 | voice | Qwen3-TTS ×2, HTDemucs-6s, MOSS-SoundEffect | 32 |
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
- **Speicher:** ~129 GB Gewichte ≈ 135 GB Network-Volume ≈ 9,5 $/Monat (0,07 $/GB)
  ≈ **8,7 €/Monat**. Die Konstitution erlaubt 5 €/Monat → **Widerspruch**
  (kleiner, aber vorhanden).
- **Start:** Pod-Start + 26–36 GB je Instanz aus dem Volume in den VRAM, grob
  2–4 Minuten (Schätzung, ungemessen), alle Instanzen parallel. Ein gestoppter
  Pod bekommt nicht garantiert dieselbe GPU zurück; sicherer ist Neu-Deploy aus
  Template + Volume (zu verifizieren).

## 5. Entscheidungen

1. ~~Pods oder Serverless~~ **Pods** (Betreiber 2026-10-07).
2. ~~Speicherbudget~~ gelöst durch den Speicher-Vorschlag in §6.1 (≈ 1,8 €/Monat).
3. **Variante wählen:** 8 → 4 oder 8 → 5 (§6.2).
4. Freigabe der Migration (§6.3).

Neue Modelle brauchen vor dem Einsatz Manifest-Einträge mit gepinnter Revision
und Lizenzprüfung (`status: 'neu'` in `AI_RESIDENT_FLEET`).

## Quellen

- RunPod-Preise: https://www.runpod.io/pricing
- https://huggingface.co/Qwen/Qwen3.6-35B-A3B · https://huggingface.co/OpenMOSS-Team/MOSS-Audio-8B-Thinking
- https://huggingface.co/ACE-Step/Ace-Step1.5 · https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice

## 6. Vorschlag (Pods, Speicher, Migration)

### 6.1 Wo die Gewichte liegen und wie sie nach und nach geladen werden

Geprüfte Preise (2026-10-07). RunPod: Container-Disk 0,10 $/GB/Monat **nur
solange der Pod läuft** (beim Stoppen gelöscht), Volume-Disk 0,10 → 0,20 $
gestoppt, Network Volume 0,07 $; in den Docs steht **kein Snapshot-Feature**.
Heißt: Gewichte brauchen einen billigen Dauer-Speicher außerhalb des Pods, der
Pod holt sie beim Start auf die Container-Disk (36 GB ≈ 0,005 $/h Laufzeit).

| Ort | Kosten für ~129 GB | Egress | Bewertung |
|---|---|---|---|
| **Cloudflare R2 (Empfehlung)** | 0,015 $/GB = **~2 $/Monat (≈ 1,8 €)** | **gratis** | S3-kompatibel, ein R2-Sync-Worker existiert schon (media-Knoten). Stabil, unabhängig von HF |
| Backblaze B2 | 0,007 $/GB = ~0,9 $/Monat | 3× Speicher gratis (≈ 3 volle Starts/Monat), danach 0,01 $/GB = ~1,3 $ je Start | billiger bei wenigen Starts; B2-Bucket `audioMONASTRY` + Key liegen schon in der `.env`. RunPod steht nicht auf der Partnerliste für gratis Egress. Ab ≥ 4 Starts/Monat teurer als R2 |
| Hugging Face direkt | 0 € | gratis | Gut als **Erstbefüllung** der Spiegel (gepinnte Revision). Als Laufzeitquelle nicht: Gating (pyannote), Rate-Limits, und ein HF-Ausfall würde den AI-Start verhindern |
| RunPod Network Volume | 129 GB × 0,07 = 9,2 $/Monat (≈ 8,4 €) | – | Schnellster Start (nur mounten), aber über deinen 5 €/Monat und an ein Rechenzentrum gebunden, das dann auch GPUs haben muss |
| Image mit eingebackenen Gewichten (GHCR) | 0 € laut bisheriger Doku | – | Der heutige Weg. Pull je Host, danach Host-Cache. Unklar: GHCR-Limits bei 30–36 GB je Image, nicht geprüft |

**Vorschlag:** R2 als Dauerspeicher (≈ 1,8 €/Monat, unter 5 €) → Erstbefüllung
aus HF mit gepinnter Revision und SHA-256-Liste → jeder Pod zieht seine
Gewichte beim Start auf die Container-Disk (parallele Range-Requests) und
prüft die Hashes.

**„Nach und nach":** Beim App-Start (AI an) starten alle Pods **parallel**; jede
Instanz meldet sich einzeln `ready`, sobald ihre Modelle geladen sind
(Reihenfolge nach `loadPriority`). Die App schaltet Funktionen frei, sobald ihre
Instanz bereit ist, zuerst `brain`. Danach gilt der Resident-Modus: nichts wird
verdrängt, nichts nachgeladen. Fällt eine Instanz aus oder bekommt keine GPU, meldet
die Funktion ehrlich „nicht verfügbar", kein Fallback. Grobe Startzeit
2–4 Minuten (Schätzung, ungemessen). GPU-Klasse: A40 und A6000 zugelassen; ein
Preis-Guard prüft den **tatsächlichen** Preis beim Anlegen (4 × L40S wären
4,0 €/h und damit zu viel).

### 6.2 Zwei Varianten

| | **8 → 4** | **8 → 5** |
|---|---|---|
| Instanzen | brain (+Orchestrator), ears, voice (TTS + Stems + SFX), music | brain (+Orchestrator), ears, voice (nur TTS), **stems** (HTDemucs + MOSS-SoundEffect), music |
| Kosten (A6000 / A40) | **1,95 / 1,80 €/h** | **2,44 / 2,25 €/h** |
| Puffer zu 4 €/h | 2,05 €/h | 1,56 €/h |
| Gewichte / Speicher | 129 GB, ≈ 1,8 €/Monat (R2) | gleich |
| Vorteil | billigster Betrieb, wenig Teile | Lange Song-Trennungen und SFX blockieren die Sprachausgabe nicht; ein Absturz in Stems reißt TTS nicht mit; Platz für BS-RoFormer neben HTDemucs zum A/B-Test |
| Nachteil | Stems/SFX und TTS teilen sich eine Karte (maxConcurrentInference 1) | +0,49 €/h (+25 %), eine Instanz mehr zu betreiben |
| Monat bei 40 h | 78 € | 98 € |

**Empfehlung: 8 → 5**, wenn die Sprachausgabe im Live-Betrieb verlässlich
reagieren soll; sonst 8 → 4 und die Stem-Instanz später abspalten (die
Belegung ist so geschnitten, dass das ohne Modellwechsel geht).

### 6.3 Migrationsplan (gilt für beide Varianten, Unterschied nur Schritt 5)

1. **Pod-Anbieter statt Serverless-Queue.** `runpodProvider.ts` spricht heute die
   Serverless-API (`/v2/<id>/run`). Neu: Pods per RunPod-API anlegen/beenden,
   Anfragen an die HTTP-Runtime der Instanz (`app.py`, existiert) über die
   Pod-URL. Das ist der größte Posten.
2. **Spiegel:** R2-Bucket befüllen (HF → R2, gepinnte Revisionen, Hash-Liste),
   Download-/Verify-Skript im Pod-Start.
3. **Manifest:** neue Modelle (Qwen3.6-35B-A3B, MOSS-Audio-8B) mit Revision
   eintragen; Rollen auf 4 bzw. 5 umstellen, `residentOnly: true`.
4. **Flottenstart:** `fleetWake.ts` startet beim AI-Start alle Pods parallel,
   führt `ready` je Instanz, beendet sie bei AI aus (+ Leerlauf-Frist);
   `aiGate.ts` verliert den Modus „mit Visuals".
5. **Rollen:** 8 → 4 (`brain`, `ears`, `voice`, `music`) bzw. 8 → 5 (zusätzlich
   `stems`). `imageHq`, `videoReal`, `videoAbstract`, `orchestrator` entfallen
   aus `GPU_ROLE_IDS`.
6. **Aufräumen:** ComfyUI-Adapter/-Workflows, `runpodVision.ts`/`runpodVideo.ts`,
   `runpod-comfyui-probe`, `write-comfyui-contracts`, Visual-Deploy-Defaults,
   MoA-Orchestrator-Pfad; Tests und Drift-Guards (`manifestRoles`, `endpointRegistry`,
   `fleetWake`, `aiGate`, `aiInfrastructure`, `test_runpod_*`) nachziehen.
7. **Messen vor Freigabe:** echte 48-GB-Karte: VRAM brain (KV-Cache), Startzeit,
   Kosten über eine Stunde; erst danach Zahlen in die Konstitution.

Betroffen sind ~30 Dateien; die 8 Rollen laufen bis zum Umschalten unverändert
weiter. Sinnvoller erster Schritt: **Pod-Spike mit einer Instanz** (`brain`
mit Qwen3.6, Pod anlegen, Hash-geprüft laden, VRAM messen, beenden) vor dem
großen Umbau.
