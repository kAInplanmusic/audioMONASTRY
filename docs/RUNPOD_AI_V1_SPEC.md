# audioMONASTRY · RunPod 3-Rollen-GPU-Flotte — Umsetzungs-Spezifikation

> Status: **beschlossen & implementiert (Kern)** · Stand: 2026-09-10
> Ersetzt die Fassung vom 2026-09-07 („eine H200, eine Runtime, ein Model Manager").

---

## 1. Entscheidung & Begründung

Alle AI-Inferenz läuft auf **RunPod Serverless**, verteilt auf **drei Rollen-Endpoints**
nach Intelligenz-Bedarf statt nach Modell-Liste:

| Endpoint | GPU | Aufgabe | ~$/h (Vollbetrieb) |
|---|---|---|---|
| `samplemonk-ai-brain` | A6000 48 GB (`AMPERE_48`) | lokales LLM: MOA-Planung, MCP-Tool-Calls, App-Steuerung | 0,39 |
| `samplemonk-ai-ears` | A6000 48 GB (`AMPERE_48`) | STT, Embeddings, Klassifikation, Diarization, Audio-QA | 0,39 |
| `samplemonk-ai-voice` | A6000 48 GB (`AMPERE_48`) | TTS, Gesang, Song, SFX, Stem-Separation | 0,39 |

Summe ≈ **1,17 $/h** bei Vollbetrieb, **≈ 0 $ bei Idle** (Scale-to-Zero + Session-Wake).
Damit bleibt die dokumentierte Budgetgrenze (4–5 €/h) eingehalten.

**Verworfen und warum:**

- **5 Einzelinstanzen** (Vorschlag vom 2026-09-10): STT (5 GB) und TTS (6 GB) allein
  auf je 24 GB = ~70 % Leerlauf; 5 Endpoints = 5 Cold-Start-Flächen.
- **3×/4× 24 GB für das Gehirn**: RunPod-Instanzen gibt es in 1×/2×/4×/8× — **nie 3×**.
  36-GB-Karten existieren nicht (Stufen: 24/48/80/94–96/141/192). 4×A5000 (96 GB,
  ~0,88 $/h) ist **teurer als 2×A6000** (96 GB, ~0,78 $/h) und hat **kein NVLink**.
- **Tensor-Parallel über PCIe ohne NVLink**: bei Batch-Größe 1 (4 User) etwa
  0,5–0,8× der Tokens/s, weil pro Layer zwei All-Reduces über den Host laufen.
  TP nur, wenn ein Modell sonst nicht passt.
- **1× H200 (141 GB, ~3,59 $/h)**: 3× Preis für keinen Mehrwert bei 4 Usern.
- **L40S (FP8)**: der FP8-Vorteil wird durch AWQ-int4 auf der A6000 ersetzt.

---

## 2. Rollen-Vertrag (einzige Quelle der Wahrheit)

**TS:** `src/core/ai/orchestrator/endpointRegistry.ts` (+ `src/config/aiInfrastructure.ts` für die Kostenregel)
**Python:** `services/samplemonk-ai-runtime/model_manifest.json` → `roles`
**Drift-Guard:** `tests/manifestRoles.test.ts` erzwingt Gleichheit von Rollen, Budgets und Preload-Sätzen.

Die Task-Mengen sind **disjunkt** – pro Task genau eine zuständige Rolle:

| Rolle | Tasks | Preload (resident) |
|---|---|---|
| brain | `llm`, `nlu` | `qwen3-4b` (`simple`), `qwen3-14b` (`moderate`/`complex`) |
| ears | `audio.classify`, `audio.transcribe`, `audio.embed`, `audio.analyze`, `audio.diarize`, `audio.understand`, `multimodal` | `ast-audioset`, `whisper-large-v3`, `clap-music` |
| voiceGen | `tts`, `sing`, `song`, `audio.generate`, `stem.separate` | `qwen3-tts-06b`, `mms-tts-deu`, `demucs` |

Der Worker wählt seine Rolle per **`AI_ROLE`** und lädt daraus nur die Modelle seines
Rollen-Manifests. `AI_ROLE` leer = Legacy-Single-Endpoint (alle Modelle, z. B. der
bestehende H200-Endpoint `uzg7p9lm890ts8`) — der Cutover ist dadurch unterbrechungsfrei.

### 2.1 Gehirn — zwei Stufen, eine Familie (Entscheidung 2026-09-11)

- **Heute aktiv:** zwei Qwen3-Modelle, beide `preload` und gleichzeitig resident
  (30 + 9 GB < 48 GB Budget, kein LRU-Wechsel):
  - `qwen3-4b` = **Ausführer** für `complexity: simple` (`RUNPOD_EXECUTOR_MODEL`)
  - `qwen3-14b` = **Brain** für `moderate`/`complex` (`RUNPOD_BRAIN_MODEL`)

  Beide über den nativen `task: "llm"`-Weg des Brain-Workers, Provider `runpod-local`.
- **Warum gleiche Familie:** ein Chat-Template, ein Tool-Call-Format, ein Prompt-Pfad.
  Weil beide resident bleiben, kostet der Stufenwechsel keinen LRU-Tausch — genau dafür
  lädt der `warmup`-Job beide (verifiziert: 37,5 s / 12,3 s Ladezeit je Modell).
- **Gemessen (2026-09-11, live):** `simple` 1,08 s / 22–23 tok/s, `complex` 1,40 s /
  16,5–16,7 tok/s (je 21 Tokens, warm). Der Ausführer ist **~25 % schneller** — der
  große Latenzhebel bleibt die Engine (vLLM), nicht die Modellzahl. Rohdaten:
  `logs/runpod-brain-latency-20260911-012329.json`.
- **Ziel (im Manifest als `status: "planned"`):** `qwen3-32b` (int4, ~20 GB, 32k Kontext)
  bzw. `qwen3-30b-a3b` (MoE, 3B aktiv, Latenz-Variante) als Brain-Upgrade.
- **Upgrade-Pfad:** `glm-4.5-air` (106B MoE/12B aktiv, int4 ~53 GB) auf **2×A6000
  (96 GB, `gpuCount=2`)** — stärkster bilingualer Agent, ~0,78 $/h.
- `gpt-oss-120b` verworfen: Harmony-Parser-Aufwand, schwächeres Deutsch, 80 GB nötig.
- **Thinking:** Qwen3 gibt sonst zuerst einen `<think>`-Block aus und frisst das
  Token-Budget. `qwen3_llm` schaltet es per Default ab (`enableThinking=false`).

> **Warum nicht sofort 32B?** Ein Produktions-Pin braucht einen echten Commit-Hash.
> Die 32B/GLM-Einträge sind deshalb `status: "planned"` und werden vom Runtime-Loader
> **ausgeschlossen**, solange keine echte Revision eingetragen ist
> (`registry.py`; `AI_INCLUDE_PLANNED=1` hebt das nur für Benchmarks auf).

---

## 3. Betriebsmodell: Scale-to-Zero + Session-Wake

1. Alle Endpoints starten mit `workers_min=0` → keine Idle-Kosten.
2. Beim Studio-Eintritt weckt `POST /api/ai/fleet/wake` die Flotte:
   `workersMin=1` je Endpoint (best effort, RunPod REST) **plus** ein `warmup`-Job
   pro Rolle, der die Preload-Modelle in VRAM lädt.
3. Da die App selbst 5–10 min zum Start braucht, ist der Kaltstart versteckt.
4. `POST /api/ai/fleet/sleep` bzw. das Idle-Timeout des `SessionManager`
   (`onScaleToZero`) setzt `workersMin` zurück auf 0.
5. `GET /api/ai/fleet/status` liefert den Rollen-Status **ohne** Netzwerkaufruf.

Relevante Env: `AI_FLEET_WAKE=0` / `AI_FLEET_SLEEP=0` deaktivieren die Mechanik
vollständig (kein Netzwerkverkehr), `RUNPOD_WARMUP_TIMEOUT_MS` deckelt den Warmup.

---

## 4. Abdeckung aller AI-Funktionen

| Fähigkeit | Deckung | Ort |
|---|---|---|
| Stem-Separation | BS-RoFormer (Qualität) + Demucs (6-Stem/Fallback) | voiceGen |
| Liederstellung | ACE-Step 1.5 XL Turbo (~24 GB) | voiceGen |
| Voice DE/EN | **Benchmark-Gate** (Fish Speech / XTTS-v2 / Qwen3-TTS) | voiceGen |
| Gesang | ACE-Step Vocals + RVC (gleiche Stimme über Speech+Song) | voiceGen |
| Ton-/Sounderstellung | Stable Audio Open, MusicGen small/medium | voiceGen |
| Audio-Erkennung | Whisper-v3, AST (Typ/Instrument), CLAP+MERT (Genre/Energy/Danceability), PyAnnote, Essentia (BPM/Key/LUFS/TruePeak/Transient) | ears |
| Audio-QA / „beschreibe das" | Qwen2-Audio-7B, on-demand per LRU | ears |
| LLM versteht App & steuert sie | lokales Brain + bestehende MCP-Tools | brain |
| dropMONK | DSP + Encoder-Features → `DropAudioAnalyzer` → aiMONK-Reasoning → `sample.search` | ears + brain + pgvector |
| Übergänge | deterministisch (`DropEngine`, `DJTransitionPanel`) — **kein** GPU-Modell | Client |
| Vorhersagen/Vorschläge | CLAP/MERT-Embeddings + pgvector-Ähnlichkeit | ears + Supabase |
| Spatial per Text | HRTF/WASM-DSP; Brain emittiert nur den Tool-Call | Client |
| MIDI-Routing | MIDI-Runtime/Mapping — deterministisch | Client |
| Audio-Enhancer / Angleich | FFmpeg/`master-player` DSP (Hetzner) | nicht GPU |
| Fallback | Client-deterministisch (`htdemucs-ONNX`, `LocalEmbeddingProvider`) + Ollama (ai-1) | Browser/Hetzner |

**Konsequenz:** Die Lücken liegen **nicht** in der GPU, sondern in (a) der
Bibliotheks-Indexierung und (b) dem mehrstufigen Agent-Loop (§6).

---

## 5. dropMONK-Pipeline

```
DROP my_808_loop.wav
   │
   ├─ essentia/librosa (CPU, deterministisch)  → BPM, Key, LUFS, True Peak, Transient
   ├─ AST (ears)                               → Typ, Instrument, Vocal-Anteil
   └─ CLAP/MERT (ears)                         → Genre-Affinität, Energy, Danceability
   │
   ▼  DropAudioAnalyzer (src/core/drop/DropAudioAnalyzer.ts)
DropAudioFeatures  →  deriveDropSuggestions()  →  place / time-stretch / similar-samples
   │
   ▼  aiMONK (brain) formuliert + ruft MCP-Tools
```

Fehlende Embedding-Werte werden **nicht erfunden**: `estimated.{energy,danceability,
genreAffinity}` markiert Schätzungen aus DSP-Werten, und die Empfehlung sagt das dem User.

### 5.1 Retrieval-Voraussetzung

Migration `database/ai_migration_007.sql` legt einen **eigenen Audio-Vektorraum** an:

- `public.sample_embeddings` bleibt der **Text**-Raum (`vector(256)`,
  `EMBEDDING_DIMS = 256` in `textEmbedding.ts`) — unverändert.
- Neu: `public.sample_audio_embeddings` (`vector(512)` = CLAP `larger_clap_music`,
  Spalten `model`/`dims`) + RPC `match_audio_samples()` + `sample_audio_embedding_stats()`.
  Grund: pgvector erlaubt pro Spalte nur **eine** Dimension – Text- und Audio-Vektoren
  können sich keine Spalte teilen, und CLAP hat 512 Dimensionen.

⚠️ **Offen:** Es existiert noch **kein Schreiber** für Audio-Embeddings. Ohne einen
Batch-Indexer über `audio.embed` (R2-Library, einmalig + bei Upload) bleibt
„ich habe drei passende Samples gefunden" leer. `sample_audio_embedding_stats()` macht
den Indexierungsgrad abfragbar.

---

## 6. Offene Arbeitspakete

| # | Paket | Status |
|---|---|---|
| 1 | Echte Revisions-Pins für `qwen3-32b`, `qwen3-30b-a3b`, `glm-4.5-air`, `mert-v1-95m`, `fish-speech`, `rvc` | offen (Manifest `status: "planned"`) |
| 2 | **Benchmark-Gate Voice DE/EN + Gesang** (AuditEval/AuditScore + MOS) → fixiert das Voice-Modell | offen |
| 3 | **Benchmark-Gate Brain**: 50–200 echte MCP-Aufgaben DE/EN (zwei Stufen live: `simple` 1,08 s / `complex` 1,40 s); bei Durchfall → GLM-4.5-Air-Upgrade (2×A6000) | offen |
| 4 | **Batch-Indexer** für `sample_audio_embeddings` | offen |
| 5 | **aiMONK-Agent-Loop**: mehrstufig planen → ausführen → prüfen → korrigieren, Kontext-Assembly (16 Plugin-IDs, `routing.json`, Session-/Projektzustand, Locks/RBAC), Bestätigungspflicht ab `WRITE` | offen |
| 6 | Voice-Handler für `fish-speech`/`rvc`, BS-RoFormer-GPU-Verifikation | offen |
| 7 | `PATCH /endpoints/{id}` (RunPod REST) gegen die echte API-Shape verifizieren | ✅ verifiziert (idleTimeout/workersMin wirken; `workersStandby=1` ist Flashboot, nicht GPU-billable) |
| 8 | **CI-Deploy**: Repo-Secret `RP_API_KEY` gehört zu einem anderen/leeren Konto; `GHCR_PASSWORD` ist ein GHCR-untaugliches fine-grained PAT | offen (User-Schritt) |

---

## 7. Risiken

- **Preise/Verfügbarkeit** von A6000-Serverless schwanken; Angaben sind Größenordnungen
  und vor Produktivbetrieb live zu prüfen.
- **Session-Wake** hängt an `RUNPOD_API_KEY`; ohne Key bleibt nur der Warmup-Job-Weg
  (kein `workersMin`-Bump) — das ist funktional, aber ohne Warmhalte-Garantie.
- **„Alle Modelle gleichzeitig resident"** (alte Regel aus `HF_MODEL_CAPABILITY_MATRIX.md` §5)
  gilt nicht mehr: pro Rolle entscheidet das `preload`-Flag; der Rest lädt per LRU.
- **Lizenzen**: MusicGen/MERT/Bark/MMS-TTS sind NC-Gewichte → nur privat/Forschung.
- **Cold-Start** bleibt real, wenn der Wake unterbleibt oder der Endpoint lange idle war.

---

## 8. Live-Zustand (2026-09-10)

| Rolle | Endpoint-ID | GPU-Pool | Worker | Idle |
|---|---|---|---|---|
| brain | `ppxo7wrn599p0q` | A40 / RTX A6000 (`AMPERE_48`) | 0..1 | 15 min |
| ears | `xeax6xrgd0csag` | A40 / RTX A6000 (`AMPERE_48`) | 0..1 | 15 min |
| voiceGen | `gajmangfldpzrk` | A40 / RTX A6000 (`AMPERE_48`) | 0..1 | 15 min |

Image: `ghcr.io/kainplanmusic/samplemonk-ai-runtime-runpod@31dc58ea` (Build-Args
`AI_INSTALL_AUDIO_AI=1 AI_INSTALL_VOICE_AI=1 AI_INSTALL_VLLM=0`).
Rollen-Smoke je Rolle grün (brain→`qwen3-14b`, ears→`ast-audioset`/`clap-music`/`whisper-large-v3`,
voiceGen→`demucs`/`mms-tts-deu`/`qwen3-tts-06b`). Kosten der Inbetriebnahme inkl.
Brain-Aktivierung **$0.052**; nach jedem Test alles auf `$0/h` abgeschaltet.
Vollständiges Protokoll: `logs/run-2026-09-10/RUN_PROTOKOLL.md`.

### 8.2 Update 2026-09-11 — zwei Stufen live

- Aktives Image: `ghcr.io/kainplanmusic/samplemonk-ai-runtime-runpod@518cad6f` (Commit `518cad6`).
  Der CI-`build` ist grün und pusht das Image; der `deploy`-Job ist rot, weil das Repo-Secret
  `RP_API_KEY` zu einem **anderen, leeren RunPod-Konto** gehört (Root-Cause in
  `RUN_PROTOKOLL.md` §14C) — deployt wird lokal via `scripts/runpod-deploy.py`.
- Brain-Smoke live (`scripts/runpod-brain-latency.py`): Warmup lädt **beide** Modelle
  (`qwen3-14b` 37,5 s, `qwen3-4b` 12,3 s), danach `simple` 1,08 s vs. `complex` 1,40 s.
  Kosten $0,0372; Endzustand `$0/h`.
- **Worker-Logs sind jetzt lesbar:** `runpodctl serverless logs <endpoint>` (v2.14.0) umgeht den
  401-„worker api key" von `/v2/{id}/logs`. Damit sind CI-Build, vLLM und Warmup nicht mehr blind.

### 8.1 Lokales Brain ist aktiv (2026-09-10)

Der Brain-Worker bedient `task: "llm"` mit `qwen3_llm` (transformers). Verifiziert mit
einer echten Generierung: `status: success`, `model: qwen3-14b`, 58 s / 64 Tokens
(Kaltstart inkl. Gewichte-Load).

**Zwei Korrekturen am ursprünglichen Plan:**

1. **Kein vLLM nötig.** RunPod stellt `/openai/v1` **nicht** für custom Serverless-Worker
   bereit (nur für vLLM-Integrationen). `runpod-local` in `src/core/ai/LlmRouter.ts` ruft
   deshalb jetzt den **nativen** Weg auf: `POST /run` + Status-Polling mit `task: "llm"`
   (über `RunPodProvider('brain')`, inkl. Fehler-Mapping und Role-Auflösung).
   `RUNPOD_BRAIN_OPENAI_URL` bleibt als optionaler Override für ein späteres vLLM-Image.
   `llm` steht dafür in `LONG_RUNNING_TASKS`, weil ein kalter Worker die Gewichte lädt.
2. **Abhängigkeits-Falle.** Der erste Live-Lauf scheiterte mit `MODEL_UNAVAILABLE`:
   `transformers==4.57.3` verlangt `huggingface-hub>=0.34,<1.0`, im Image lag aber
   `huggingface-hub==1.31.0` (von `qwen-tts`/`diffusers` heraufgezogen). Der Import
   scheitert erst in einer ImportError-Kaskade – ein simples `import transformers`
   löst den Versionscheck **nicht** aus, deshalb war die erste CI-Probe blind.
   Jetzt: harter Pin in `requirements.in` + den Rollen-Locks, `pip install` **nach** allen
   Lock-Installs, und eine Build-Prüfung über denselben Pfad wie der Worker
   (`exec('from transformers import *')`). Details: `logs/run-2026-09-10/RUN_PROTOKOLL.md` §7.

**Verhaltens-Hinweis:** Qwen3 gibt zuerst einen `<think>`-Block aus. Für Tool-Calling
sollte der Brain-Handler Thinking abschalten (`enable_thinking=False` bzw.
`/no_think`), sonst frisst der Denkblock das Token-Budget – offen in `MASTER_TODO.md` AI-P1-003.

⚠️ **CI-Deploy ist rot** (Läufe #8–#12): `build` grün, `deploy` rot, obwohl der Preflight
zeigt, dass `RP_API_KEY` im Repo gesetzt ist. Das lokale Deploy funktioniert. Da die
Actions-Logs ohne gültigen Token nicht lesbar sind, läuft die Diagnose über
Step-Status-Proben im Workflow.
