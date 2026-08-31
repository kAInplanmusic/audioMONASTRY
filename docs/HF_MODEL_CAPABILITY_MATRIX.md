# HF Model Capability Matrix – audioMONASTRY / SampleMONK

> Zweck: Jedes Hugging-Face-Kandidatenmodell wird **vor** einer Integration anhand
> einheitlicher Kriterien bewertet. Nur Modelle mit sinnvollem Gesamt-Nutzen
> werden integriert. Diese Matrix ist ein lebendes Dokument – alle Werte sind
> Ersteinschätzungen und werden vor der jeweiligen Integration live verifiziert.
>
> Stand: 2026-08-31 · Phase 0 · **Projektzweck: privat/Forschung (kein kommerzieller Zweck)** –
> damit sind CC-BY-NC/NC-SA-Lizenzen der Modell-Gewichte für dieses Projekt geklärt.

---

## 1. Bewertungsschema

| Score | Bedeutung |
|---|---|
| **USEFULNESS** (U) | Produktnutzen für SampleMONK (0–10) |
| **QUALITY** (Q) | Erwartete Ausgabequalität (0–10) |
| **PERFORMANCE** (P) | Inferenz-Latenz/Durchsatz auf Ziel-GPU (0–10) |
| **VRAM EFFICIENCY** (V) | VRAM-Nutzung im Verhältnis zum Nutzen (0–10) |
| **INTEGRATION** (I) | Aufwand/Risiko der Einbindung in den AI Orchestrator (0–10) |
| **PRODUCTION RISK** (R) | Lizenz, Stabilität, Ops-Risiko (0–10; **10 = sehr riskant**) |

**Gewichteter Gesamtnutzen:**
`0.25·U + 0.25·Q + 0.15·P + 0.10·V + 0.15·I + 0.10·(10 − R)`

**Aufnahmekriterium:** gewichteter Score **≥ 6,0** UND Lizenz erlaubt
kommerzielle Nutzung UND Produktions-Risiko ≤ 4. Modelle darunter → „Beobachten"
(nicht integrieren).

### 1.1 Lizenz-Legende (was die Kürzel bedeuten)

| Kürzel | Bedeutung | Kommerzielle Nutzung? |
|---|---|---|
| **MIT** | Sehr freizügig: nutzen, ändern, verkaufen erlaubt; nur Lizenztext/Namensnennung beibehalten | ✅ ja |
| **Apache-2.0** | Wie MIT, zusätzlich Patentklausel; Namensnennung + Lizenztext | ✅ ja |
| **CC-BY** | Creative Commons: Nutzung erlaubt, Urheber muss genannt werden | ✅ ja (mit Namensnennung) |
| **CC-BY-NC** | Creative Commons **Non-Commercial**: nur nicht-kommerzielle Nutzung | ⛔ nein |
| **CC-BY-NC-SA** | Non-Commercial + **Share-Alike** (Weitergabe unter gleicher Lizenz) | ⛔ nein |
| **HF-Gate / Gated** | Modell im HF-Hub gesperrt; erfordert Annahme der Modell-Lizenz im HF-Account | je nach Modell-Lizenz |
| **Code vs. Gewichte** | Oft ist der **Code** MIT/Apache, aber die trainierten **Gewichte** NC-lizenziert – entscheidend sind die **Gewichte**, die wir ausliefern | → immer Gewichte prüfen |

### 1.2 Score-Legende (letzte Tabellenspalte)

Die Zahlen am Zeilenende (`8·7·8·8·9·2`) sind die sechs Bewertungen in fester
Reihenfolge **U·Q·P·V·I·R** (jeweils 0–10), z. B. `8·7·8·8·9·2` =
USEFULNESS 8 · QUALITY 7 · PERFORMANCE 8 · VRAM-EFF 8 · INTEGRATION 9 ·
PRODUCTION-RISK 2.

---

## 2. Kandidaten-Matrix (Ersteinschätzung, vor Integration live verifizieren)

### 2.1 Audio Classification / Tagging

| Modell | Task | Lizenz | Input → Output | VRAM FP16 (est.) | RAM | Kaltstart | Latenz | Qualität | Audioformat | Max-Dauer | Concurrency | Quant | GPU | Prod | MCP | Scores U·Q·P·V·I·R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `MIT/ast-finetuned-audioset-10-10-0.4593` | Audio-Tagging (527 Klassen) | MIT | Audio → Labels+Scores | ~2–3 GB | ~4 GB | ~10–20 s (Image vorhanden) | ~0,5–2 s / Clip | sehr gut | WAV/MP3/FLAC | ~10 s (Segmentierung intern) | batch-fähig | INT8 möglich | T4/L4 reicht | ✅ | ✅ Auto-Tagging | 8·7·8·8·9·2 |

**Empfehlung:** ✅ **Stufe 1** – Kern für Library-Auto-Tagging/Suche.

### 2.2 Music Understanding / Music Embeddings

| Modell | Task | Lizenz | Input → Output | VRAM FP16 (est.) | RAM | Kaltstart | Latenz | Qualität | Audioformat | Max-Dauer | Concurrency | Quant | GPU | Prod | MCP | Scores U·Q·P·V·I·R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `m-a-p/MERT-v1-95M` | Music-Understanding/Embeddings (Beat, Genre, Instrument, Emotion) | Apache-2.0 (Modell-Code) / CC-BY-NC-SA-4.0 (Gewichte) ⚠️ | Audio → Embedding+Label | ~1 GB | ~2 GB | ~10–15 s | <0,5 s | sehr gut | WAV | ~10 s | hoch | INT8 möglich | T4/L4 | ⚠️ Gewichte nicht-kommerziell → prüfen bzw. Alternative wählen | ✅ Ähnlichkeitssuche | 7·7·9·10·8·2 |

**Empfehlung:** ✅ **Lizenz geklärt** (privat/Forschung). `laion/larger_clap_music` (CLAP, 2.3) als Alternative bleibt dokumentiert.

### 2.3 Audio Embeddings (Text ↔ Audio, Multimodal Search)

| Modell | Task | Lizenz | Input → Output | VRAM FP16 (est.) | RAM | Kaltstart | Latenz | Qualität | Audioformat | Max-Dauer | Concurrency | Quant | GPU | Prod | MCP | Scores U·Q·P·V·I·R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `laion/clap-630k-audio` | Text↔Audio-Embeddings | MIT | (Text, Audio) → gemeinsamer Embedding-Raum | ~2–3 GB | ~4 GB | ~10–20 s | <0,5 s | gut | WAV | ~10 s | hoch | FP16 | L4 | ✅ | ✅ Suche | 7·7·7·7·7·3 |
| `laion/larger_clap_music` | Music-spezifische CLAP-Embeddings | MIT | (Text, Audio) → Embedding | ~3–4 GB | ~6 GB | ~15–25 s | <1 s | gut–sehr gut | WAV | ~10 s | hoch | FP16 | L4 | ✅ | ✅ Suche | 7·8·7·6·7·3 |

**Empfehlung:** ✅ **Stufe 1** – `larger-clap-music` als musik-spezifischer Standard.

### 2.4 Speech-to-Text / Transkription

| Modell | Task | Lizenz | Input → Output | VRAM FP16 (est.) | RAM | Kaltstart | Latenz | Qualität | Audioformat | Max-Dauer | Concurrency | Quant | GPU | Prod | MCP | Scores U·Q·P·V·I·R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `openai/whisper-large-v3` | STT/Transkription (99 Sprachen) | Apache-2.0 | Audio → Text (segmente) | ~4–5 GB | ~6 GB | ~20–40 s | ~1–3× Echtzeit auf A100 | sehr gut | WAV/MP3 | ~30 s Segmente, beliebig via Chunking | 1–2 parallel | INT8 möglich | L4/A100 | ✅ | ✅ | 9·9·6·6·9·2 |

**Empfehlung:** ✅ **Stufe 1** – Transcription für Voice-/Sample-Analyse.

### 2.5 Text-to-Speech / Gesang (bereits im Einsatz)

| Modell | Task | Lizenz | Input → Output | VRAM FP16 (est.) | RAM | Kaltstart | Latenz | Qualität | Audioformat | Max-Dauer | Concurrency | Quant | GPU | Prod | MCP | Scores U·Q·P·V·I·R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `facebook/mms-tts-deu` (bestehend) | TTS (deutsch) | CC-BY-NC ✅ privat/Forschung | Text → WAV | ~2 GB | ~3 GB | ~15–25 s | schnell | gut (deutsch) | WAV | ~30 s | hoch | FP16 | L4 | ⚠️ NC-Lizenz prüfen | ✅ | 7·6·8·7·10·2 |
| `suno/bark` (bestehend) | TTS + Gesang (multilingual) | MIT (Code) / Gewichte teils NC ✅ privat/Forschung | Text → WAV | ~5–10 GB | ~8 GB | ~30–60 s | mittel | sehr gut | WAV | ~14 s/Chunk, verlängerbar | 1 | INT8 möglich | A10G/A100 | ⚠️ Lizenz prüfen | ✅ | 8·7·5·5·9·3 |

**Empfehlung:** ✅ behalten (Serverless-Pfad); Lizenz geklärt (privat/Forschung).

### 2.6 Music Generation

| Modell | Task | Lizenz | Input → Output | VRAM FP16 (est.) | RAM | Kaltstart | Latenz | Qualität | Audioformat | Max-Dauer | Concurrency | Quant | GPU | Prod | MCP | Scores U·Q·P·V·I·R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `facebook/musicgen-small` | Musik-Generierung aus Text/Melodie | CC-BY-NC ✅ privat/Forschung (Code MIT) | Text → Musik | ~2–3 GB | ~4 GB | ~15–25 s | ~10–20 s / 30 s Audio | gut | WAV | 30 s (verlängerbar) | 1–2 | INT8 möglich | L4 | ⚠️ NC prüfen | ✅ | 6·6·8·8·8·2 |
| `facebook/musicgen-medium` | Musik-Generierung (höhere Qualität) | CC-BY-NC ✅ privat/Forschung | Text → Musik | ~8–10 GB | ~12 GB | ~30–60 s | ~30–60 s / 30 s Audio | sehr gut | WAV | 30 s (verlängerbar) | 1 | INT8 möglich | A10G/A100 | ⚠️ NC prüfen | ✅ | 7·8·5·5·8·3 |
| `facebook/musicgen-melody` | Melodie-geführte Generierung | CC-BY-NC ✅ privat/Forschung | Text+Melodie → Musik | ~8–10 GB | ~12 GB | ~30–60 s | ~30–60 s / 30 s Audio | sehr gut | WAV | 30 s | 1 | INT8 | A10G/A100 | ⚠️ NC prüfen | ✅ | 6·7·5·5·7·3 |

**Empfehlung:** ✅ **Stufe 1:** `musicgen-small`; `-medium` on-demand.
**Wichtig:** MusicGen-Gewichte sind **CC-BY-NC** → kommerzielle Nutzung klären
oder Alternative evaluieren (`stable-audio-open`? ggf. später ergänzen).

### 2.7 Audio Generation (SFX / Sound Design)

| Modell | Task | Lizenz | Input → Output | VRAM FP16 (est.) | RAM | Kaltstart | Latenz | Qualität | Audioformat | Max-Dauer | Concurrency | Quant | GPU | Prod | MCP | Scores U·Q·P·V·I·R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `cvssp/audioldm2` | Text → Soundeffekte/Audio | CC-BY-NC-SA ✅ privat/Forschung | Text → Audio | ~6–8 GB | ~10 GB | ~40–80 s | langsam | mittel–gut | WAV | ~10 s | 1 | FP16 | A10G/A100 | ⚠️ Lizenz + Latenz | ✅ | 6·6·4·4·6·4 |

**Empfehlung:** ⏸️ **Beobachten** (Score 5,5 < 6,0; Latenz/Lizenz). Erst nach
echtem Bedarf für KI-Sounddesign wieder aufnehmen.

### 2.8 Multimodal Reasoning (Vision + Audio + Text)

| Modell | Task | Lizenz | Input → Output | VRAM FP16 (est.) | RAM | Kaltstart | Latenz | Qualität | Audioformat | Max-Dauer | Concurrency | Quant | GPU | Prod | MCP | Scores U·Q·P·V·I·R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `Qwen/Qwen2.5-Omni-7B` | Vision+Audio+Text Reasoning (Omni) | Apache-2.0 (Modell) | Bild/Audio/Text → Text/Audio | ~16–18 GB | ~24 GB | ~60–120 s | mittel | sehr gut | WAV/Bilder | kontextabhängig | 1 | INT8 → ~9–10 GB | A100 | ✅ | ✅ | 8·8·4·4·7·5 |

**Empfehlung:** ⏳ **Phase 2+** (schwer, teuer). Erst wenn konkrete
Multimodal-Anforderungen existieren (z. B. „beschreibe diese Session").

### 2.9 Speaker Diarization / erweiterte Audio-Analyse

| Modell | Task | Lizenz | Input → Output | VRAM FP16 (est.) | RAM | Kaltstart | Latenz | Qualität | Audioformat | Max-Dauer | Concurrency | Quant | GPU | Prod | MCP | Scores U·Q·P·V·I·R |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `pyannote/speaker-diarization-3.1` | Sprecher-Trennung (Diariation) | MIT (Code) / HF-Gate (Annahme im Account nötig) | Audio → Sprecher-Segmente | ~4–6 GB | ~8 GB | ~30–60 s | ~0,5–1× Echtzeit | sehr gut | WAV | beliebig (Chunking) | 1 | FP16 | A10G/A100 | ⚠️ HF-Gate-Annahme erforderlich | ✅ | 7·8·5·6·7·3 |

**Empfehlung:** ⏳ **Phase 2** – für VoiceMONK/Collab-Meetings sinnvoll.

---

## 3. Gesamtliste mit gewichtetem Score (Priorität)

| Priorität | Modell | Gewichteter Score | Aufnahme? |
|---|---|---|---|
| 🥇 | `MIT/ast-finetuned-audioset-10-10-0.4593` | **7,90** | ✅ Stufe 1 |
| 🥇 | `openai/whisper-large-v3` | **8,15** | ✅ Stufe 1 |
| 🥈 | `m-a-p/MERT-v1-95M` | 7,85 | ✅ privat/Forschung ok |
| 🥈 | `laion/larger_clap_music` | 7,10 | ✅ Stufe 1 |
| 🥈 | `facebook/musicgen-small` | 7,00 | ✅ Stufe 1 (NC privat/Forschung ok) |
| 🥉 | `facebook/mms-tts-deu` | 7,45 | ✅ Bestand (NC privat/Forschung ok) |
| 🥉 | `suno/bark` | 7,05 | ✅ Bestand |
| 🥉 | `facebook/musicgen-medium` | 6,90 | ✅ On-demand |
| ⏳ | `pyannote/speaker-diarization-3.1` | 6,85 | Phase 2 |
| ⏳ | `Qwen/Qwen2.5-Omni-7B` | 6,55 | Phase 2+ |
| ⏳ | `facebook/musicgen-melody` | 6,25 | Phase 2 |
| ⏸️ | `cvssp/audioldm2` | 5,50 | Beobachten |

---

## 4. Lizenz-Status (geklärt 2026-08-31: privat/Forschung)

1. **MusicGen** (`facebook/musicgen-*`): CC-BY-NC → ✅ **privat/Forschung ok**.
2. **Bark/MMS-TTS**: ✅ **privat/Forschung ok**.
3. **MERT**: CC-BY-NC → ✅ **privat/Forschung ok**; CLAP (Apache-2.0) als Alternative dokumentiert.
4. **PyAnnote**: HF-Gated-Model → Annahme der Modell-Lizenz im HF-Account nötig (einmalig).

---

## 5. VRAM-/CPU-Summe „alle Modelle gleichzeitig" (Betriebsentscheidung)

**Betriebsmodus (Betreiber-Freigabe 2026-08-31):** Es gibt **keinen
Einzelmodell-Test**. Es laufen immer **alle** Modelle gleichzeitig – manche
öfter, manche seltener genutzt, aber alle resident.

**GPU-Modelle (auf A100):**
- Betreiber-Schätzung: **~53 GB** für alle gewünschten Modelle gleichzeitig.
- Eigene Ersteinschätzung: FP16-Summe ~65–80 GB; mit INT8/FP16-Mix ~35–50 GB.
- **Entscheidung:** **1× A100 (80 GB)** – die ~53 GB passen mit Puffer in 80 GB,
  auch ohne aggressive Quantisierung.
- **2×L40S existiert bei HF Endpoints nicht** (L40S nur 1× 48 GB / 4× / 8×);
  1×L40S (48 GB) wäre zu knapp unter 53 GB.

**CPU-Modelle (aus der ersten Liste, laufen auf CPU der A100-Instanz):**

| Modell | CPU-RAM-Bedarf ca. | Anmerkung |
|---|---|---|
| `m-a-p/MERT-v1-95M` (Music Understanding) | ~2 GB | CPU-geeignet, sehr klein |
| `laion/larger_clap_music` (Audio Embeddings) | ~6 GB | CPU-geeignet |
| `MIT/ast-finetuned-audioset-...` (Audio Classification) | ~4 GB | CPU-geeignet, Batch ok |
| `facebook/mms-tts-deu` (TTS, bestehend) | ~3 GB | CPU-geeignet |
| `openai/whisper-large-v3` (STT) | ~6 GB | GPU bevorzugt, CPU als Fallback |
| `facebook/musicgen-small` (Music Gen) | ~4 GB | GPU bevorzugt, CPU als Fallback |
| **Summe CPU-RAM** | **~25 GB** | muss auf der A100-Instanz verfügbar sein (live verifizieren) |

- HF-Endpoints-GPU-Instanzen bringen **CPU + System-RAM mit** – die CPU-Modelle
  laufen dort im selben Container (kein separater Endpoint nötig).
- Falls der System-RAM der A100-Instanz nicht reicht oder CPU-Contention
  entsteht: **optionaler HF-CPU-Endpoint** (`intel-spr`, ~$0.033/h ≈ 0,03 €/h)
  oder Verlagerung auf die bestehende Hetzner-CPU-Instanz `ai-1` (Ollama).

**Gesamtkosten (A100 + CPU):** **$2.50/h + $0.033/h ≈ $2.53/h ≈ 2,33 €/h**
→ weiterhin deutlich unter dem Budget (max. 4–5 €/h).

→ **Kein Modell wird weggelassen.** Kein Scaling nach oben, solange die A100
nicht nachweislich nicht reicht (siehe `HF_ENDPOINT_DEPLOYMENT_PLAN.md`).
