# Pod-Liste — audioMONASTRY (Final)

**Stand**: 2026-11-09 | Commit: `00f4b0b` | 8 Pods = 8× A40 48GB

---

## Übersicht

| Pod | Rolle | GPU | VRAM Budget | Modelle | Archive | Status |
|-----|-------|-----|-------------|---------|---------|--------|
| A01 | brain | A40 48GB | 42 GB | qwen3-30b-a3b-awq, qwen3-4b | 31.48 GB | Active |
| A02 | ears | A40 48GB | 42 GB | whisper-large-v3, clap-music, mert-v2-330m, qwen2-audio-7b, pyannote-diarization, ast-audioset | 25.18 GB | Active |
| A03 | voiceGen | A40 48GB | 42 GB | qwen3-tts-17b, qwen3-tts-voicedesign, qwen3-tts-06b-base, acestep-v15-shared | 20.16 GB | Active |
| A04 | music | A40 48GB | 42 GB | acestep-v15-xl-sft, acestep-v15-xl-turbo, acestep-5hz-lm-4b, acestep-v15-shared | 57.29 GB | Active |
| A05 | studio | A40 48GB | 42 GB | bs-roformer-sw-6stem, htdemucs-6s, moss-soundeffect-v2.0, acestep-v15-xl-base | 31.62 GB | Active |
| A06 | audioBrain | A40 48GB | 42 GB | qwen3-omni-30b, music-flamingo | 41.10 GB | Active |
| A07 | song | A40 48GB | 42 GB | music-flamingo, yue2-3b | ~39 GB | Active |
| A08 | vis | A40 48GB | 42 GB | master-player, music-flamingo, musicgen-small, songstarter | ~25 GB | Active |

---

## Details je Pod

### A01 — brain (immer an)
- **Start-Trigger**: always (erster Nutzer im Studio)
- **Modelle**: qwen3-30b-a3b-awq (22.78 GB) + qwen3-4b (8.70 GB)
- **Aufgabe**: App-/Plugin-Steuerung, Tool-Calls, MoA-Planung, Streaming vLLM
- **Besonderheit**: warm halten während Session (workersMin=1), TTFT < 300 ms Ziel

### A02 — ears (immer an)
- **Start-Trigger**: always (erster Nutzer im Studio)
- **Modelle**: whisper-large-v3 (5.75), clap-music (0.73), mert-v2-330m (2.36), qwen2-audio-7b (15.65), pyannote-diarization (0.04), ast-audioset (0.65)
- **Ziel-Modelle** (FLEET-P1-002..005): qwen3-asr-1.7b, moss-audio-8b-instruct, pyannote-community-1, songformer, beat-this, clip-vit-l14
- **Aufgabe**: STT, Embeddings, Klassifikation, Diarisierung, Audio-LLM

### A03 — voiceGen (bei AI-Generierung)
- **Start-Trigger**: aiGeneration (erster tts/sing/song/audio.generate Auftrag)
- **Modelle**: qwen3-tts-17b (4.21), qwen3-tts-voicedesign (4.21), qwen3-tts-06b-base (2.34), acestep-v15-shared (9.40)
- **Aufgabe**: TTS (CustomVoice, VoiceDesign), Stimm-Cloning via Referenz-Audio (Datei-Upload)
- **Wichtig**: **Kein STT, kein Mikrofon** — reine Text-basierte KI-Steuerung

### A04 — music (bei AI-Generierung)
- **Start-Trigger**: aiGeneration
- **Modelle**: acestep-v15-xl-sft (20.02), acestep-v15-xl-turbo (20.02), acestep-5hz-lm-4b (7.85), acestep-v15-shared (9.40)
- **Aufgabe**: Musik-Generierung (ACE-Step 1.5 XL), LM-Planer, Repaint
- **Besonderheit**: vLLM gpu_memory_utilization ~0.33 hart deckeln

### A05 — studio (bei AI-Generierung + stemMONK)
- **Start-Trigger**: aiGeneration + stemMONK-Lock
- **Modelle**: bs-roformer-sw-6stem (0.83), htdemucs-6s (0.31), moss-soundeffect-v2.0 (10.46), acestep-v15-xl-base (20.02)
- **Aufgabe**: Post-Produktion (Mastering, Reparatur, Voice-Conversion, Super-Res) + Stem-Trennung (6 Stems → 5 via Crossover)

### A06 — audioBrain (bei AI-Generierung)
- **Start-Trigger**: aiGeneration
- **Modelle**: qwen3-omni-30b (25.68), music-flamingo (15.42)
- **Aufgabe**: Audio-LLM (Qwen3-Omni 30B MoE int4) + Musik-Reasoning/Critique (Music Flamingo)
- **Risiko**: ~43 GB VRAM > 42 GB Budget → Mitigation: music-flamingo offload bei Omni-Last oder int4-Quantisierung

### A07 — song (bei AI-Generierung)
- **Start-Trigger**: aiGeneration
- **Modelle**: music-flamingo (15.42), yue2-3b (~24 GB est.)
- **Aufgabe**: Song-Generierung (YuE2-3B Frontier-Qualität), Music Flamingo als Companion

### A08 — vis (immer an bei Fulldeploy)
- **Start-Trigger**: always
- **Modelle**: master-player (8), music-flamingo (15.42), musicgen-small (4), songstarter (6)
- **Aufgabe**: Visuals rendern (NVENC H.264/HEVC, 1080p60) + /visual-out Stream + leichte Audio-Generierung
- **GPU**: A40 48GB (H.264/HEVC Hardware-Encoder, kein AV1 — reicht für 1080p60)
- **Kosten**: kein separater RTX 4090 nötig

---

## Start-Trigger & Reihenfolge

| Order | Pod | Trigger |
|-------|-----|---------|
| 1 | brain | always (Session-Start) |
| 2 | ears | always (Session-Start) |
| 3 | vis | always (Fulldeploy) |
| 4 | voiceGen | aiGeneration (tts/song/...) |
| 5 | music | aiGeneration |
| 6 | studio | aiGeneration + stemMONK |
| 7 | audioBrain | aiGeneration |
| 8 | song | aiGeneration |

---

## Kosten

| Posten | EUR/h |
|--------|-------|
| 8× A40 48GB @ 0.49 $ | ~3.92 |
| Hetzner Fleet (5 Server) | ~0.054 |
| **Gesamt** | **~3.97 EUR/h** |

Budget: ≤10 EUR/h Fleet, ≤4 EUR/h AI-Aufpreis → **OK**

---

## Offene Risiken

1. **audioBrain VRAM** (~43 GB > 42 GB) → FLEET-P1-011 Messung nötig
2. **music Pod Archive** (57 GB) vs. VRAM (~31 GB) → Archive enthalten HF-Cache, echte VRAM niedriger
3. **Keine GPU-Messungen** — alle Werte sind Schätzungen (FLEET-P1-011)
4. **Lizenzen**: bs-roformer-sw-6stem (unknown), songformer (unclear), beat_this (weights unlicensed), mel-roformer-* (no tag/GPL)

---

## Nächste Schritte

- [ ] FLEET-P1-011: GPU-Messungen auf A40 (VRAM, Latency, Realtime-Faktor)
- [ ] audioBrain Mitigation umsetzen (music-flamingo offload oder int4)
- [ ] Lizenzen klären für kommerzielle Nutzung
- [ ] pod-fleet.json mit finalen Modellen deployen