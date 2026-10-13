# AI_FLEET_STARTPLAN: 5 RunPod-Pods, Start-Trigger und Modelle

Stand: 2026-10-12 · Entscheidungen des Betreibers (Start-Trigger und LEGO-Zuordnung; Modell-Set je Pod) · gilt zusammen mit `docs/AI_FLEET_6X48_PLAN.md` (Herleitung) und `deploy/runpod/pod-fleet.json` (Deploy-Quelle).

| Pod | Rolle | Start-Trigger | Modelle (Zielbild 2026-10-12) |
|---|---|---|---|
| RP1 | brain | **immer an bei Start** | unverändert (Steuerung, Executor, Streaming; Ziel: warm, TTFT < 300 ms) |
| RP2 | ears | **immer an bei Start** | Qwen3-ASR, MOSS-Audio-8B-Instruct, pyannote community-1, CLAP, MERT, AST, SongFormer, beat_this, CLIP, essentia |
| RP3 | music | wenn AI-Generierung gestartet wird | ACE-Step 1.5 XL sft + turbo, 5Hz-LM-4B-Planer; Gesang über ACE-Step-Lyrics |
| RP4 | voice | wenn AI-Generierung gestartet wird | Qwen3-TTS (CustomVoice, VoiceDesign, 0.6B-Base), MOSS-SoundEffect, **LEGO** (`acestep-v15-xl-base`) |
| RP5 | stems | wenn stemMONK gestartet wird | BS-RoFormer SW 6-Stem (+ SCNet XL IHF als Fallback), Mel-RoFormer Karaoke/Dereverb auf Wunsch, beat_this |

Die Start-Trigger stehen je Pod als `startTrigger` in `deploy/runpod/pod-fleet.json` (`always`, `aiGeneration`, `stemMONK`); geprüft von `tests/podFleetConfig.test.ts`. Im Pod-Modus (`AI_FLEET_MODE=pods`) löst `src/core/ai/orchestrator/podStartTriggers.ts` sie aus (Stand 2026-10-13, FLEET-P1-001, Test `tests/podStartTriggers.test.ts` mit gemockter Flotte, **kein Live-Beweis**):

- `always`: erster Nutzer im Studio (`onStudioPresence`) → RP1 + RP2.
- `aiGeneration`: erster Auftrag `tts`/`sing`/`song`/`audio.generate` (also auch MCP `music.*`/`voice.*`) → RP3 + RP4; der Auftrag wartet nur auf seinen eigenen Pod.
- `stemMONK`: stemMONK-Lock geholt oder Modus nicht OFF (Realtime-Hub → `onPluginActivity`) bzw. ein `stem.separate`-Auftrag → RP5.
- Wecken = `GET /ready`; läuft der Pod nicht und sind `RP_POD_ID_<POD>` + RunPod-Key gesetzt: `POST /pods/<id>/start` (gestoppten Pod fortsetzen), dann `/ready` pollen. Anlegen kann weiter nur `scripts/runpod-pods.py up`.
- Sperren vor jedem Netzwerkaufruf: AI-Schalter, Kill-Switch, `AI_MAX_AI_EUR_PER_HOUR` (laufende + neue Pods × A40-Pod-Preis). Zustand in `fleetStatus().podStartTriggers`, Logzeilen `fleet pod ...`.
- Offen: Pods nach Session-Ende wieder stoppen (heute nur `runpod-pods.py down`).

## LEGO-Zuordnung (Entscheidung 2026-10-12)

`music.lego`, `music.extract`, `music.complete` laufen nur mit `acestep-v15-xl-base`. Dieses Modell liegt auf **RP4 (voice)**:

- RP4 startet mit der AI-Generierung, LEGO ist eine Generierung, der Pod läuft dann ohnehin. RP5 startet erst mit dem stemMONK.
- RP5 bleibt für die Trennung frei, damit lange Song-Trennungen LEGO und TTS nicht bremsen.
- Für `music.repaint` bleibt der 4B-Planer auf RP3. `music.generate` (MCP) und `/api/voice/song` zeigen seit 2026-10-12 auf `acestep-v15-xl-sft` (RP3), nicht mehr auf xl-base.
- TTS (live) und LEGO teilen sich RP4. **TTS hat Vorrang, ein LEGO-Lauf darf unterbrochen werden** (Live-Mandat, AGENTS.md 1.3). Umsetzung: FLEET-P1-009 (serverseitig seit 2026-10-13: `src/core/ai/orchestrator/podJobQueue.ts`, Priorität tts > sfx > lego/extract/complete, TTS bricht einen laufenden LEGO-Job mit `PREEMPTED_BY_TTS` ab; der Pod-Server hat noch keinen Abbruch-Endpunkt, ein schon laufender GPU-Schritt rechnet dort zu Ende).

## Lizenzgrundsatz (Betreiber 2026-10-12)

- Betrieb ist **privat/Forschung**. Nicht-kommerzielle Lizenzen sind erlaubt, essentia (AGPL-3.0) ist akzeptiert.
- Bei späterer **kommerzieller Nutzung** gelten Fallbacks: **SCNet XL IHF statt BS-RoFormer SW**, **MERT streichen**. Zusätzlich vor kommerzieller Nutzung prüfen: alle Einträge mit `licenseCheck` in `AI_RESIDENT_FLEET` (pyannote community-1, SongFormer, beat_this-Gewichte, Mel-RoFormer Karaoke/Dereverb, SCNet-Trainingsdaten).
- Herkunftsnachweis für Code und Konzepte bleibt `docs/KONZEPT_HERKUNFT.md`.

## Wo das Modell-Set steht (drei Ebenen)

| Ebene | Datei | Inhalt |
|---|---|---|
| Zielbild | `src/config/aiInfrastructure.ts` → `AI_RESIDENT_FLEET` | Entscheid 2026-10-12, VRAM-Schätzung je Modell |
| Deploy | `deploy/runpod/pod-fleet.json` → `pods[].models` / `pods[].target` | `models` = heute ladbar (wird als `AI_ROLE_MODELS` an den Pod gegeben), `target` = Spiegel des Zielbilds |
| Gewichte | `services/audiomonastry-ai-runtime/model_manifest.json` | Repo, Revision, Lizenz; neue Modelle mit `status: "neu"` |

**Kein stiller Modellwechsel.** Für die neuen Modelle gibt es noch keine Handler. Sie stehen deshalb mit `status: "neu"` im Manifest und in **keiner Rolle**; `registry.apply_role` lehnt eine Rolle mit einem `neu`-Modell ab. Ein heute ausgerolltes Modell, das nicht mehr im Ziel steht, bleibt ausgerollt, bis das Ticket in `target.retireAfter` erledigt ist (z. B. whisper-large-v3 bis FLEET-P1-002). `PIN-ERFORDERLICH` als Revision ist nur bei `status: "neu"` zulässig.

## Modelle je Pod (Entscheid 2026-10-12)

Allgemein für alle Pods: nutzbar sind **42 GB je A40** (48 GB minus 6 GB Marge, `model_manifest.json` `runtime`). **bf16 wird erzwungen**, wo das Repo fp32 liefert. Revisionen wurden am 2026-10-12 per HF-API gelesen (`https://huggingface.co/api/models/<repo>`, Feld `sha`). Parameterzahlen stammen aus demselben API-Aufruf (`safetensors.parameters`).

> **UNBELEGT: Alle VRAM-Werte sind Schätzungen.** Sie sind aus Parameterzahl × 2 Byte (bf16) plus einem Aufschlag für Aktivierungen gerechnet bzw. aus dem Manifest übernommen. Es gibt **keine Messung auf einer A40** und keine Messung mit 4 gleichzeitigen Nutzern. Die Spitzenwerte misst FLEET-P1-011.

### RP1 brain (immer an)

Unverändert. Vermerkte **Widersprüche** (nicht aufgelöst, Entscheid nötig):

- `pod-fleet.json` rollt `qwen3-30b-a3b-awq` + `qwen3-4b` aus (Manifest 20 + 9 = 29 GB).
- `AI_RESIDENT_FLEET` nennt `qwen3.6-35b-a3b-fp8` (36 GB, Status `neu`, steht **nicht** im Manifest).
- Die Manifest-Rolle `brain` lädt im Serverless-Betrieb `qwen3-8b-int4`, `qwen3-14b`, `qwen3-4b`.
- Die frühere VRAM-Bilanz dieses Dokuments nannte 36 GB.

### RP2 ears (immer an)

| Modell (ID) | HF-Repo | Revision | VRAM (Schätzung) | Lizenz | Funktion |
|---|---|---|---|---|---|
| `qwen3-asr-1.7b` | Qwen/Qwen3-ASR-1.7B | `7278e1e70fe206f11671096ffdd38061171dd6e5` | 5 GB (2,35 Mrd. Param. bf16) | Apache-2.0 | Sprache → Text, Streaming, **ohne Wort-Timestamps** |
| `moss-audio-8b-instruct` | OpenMOSS-Team/MOSS-Audio-8B-Instruct | `d4dc5a6d8cd79b43dcd82884c75e303b1ecd016d` | 19 GB (9,05 Mrd. Param. bf16) | Apache-2.0 | Audio-LLM: Fragen zu Klang, Musik, Sprache (Instruct, **nicht** Thinking) |
| `pyannote-community-1` | pyannote/speaker-diarization-community-1 | `3533c8cf8e369892e6b79ff1bf80f7b0286a54ee` | 1 GB | CC-BY-4.0, gated | Sprecher-Diarisierung, pyannote.audio 4.x |
| `clap-music` | laion/larger_clap_music | `a0b4534a14f58e20944452dff00a22a06ce629d1` | 4 GB (Manifest) | Apache-2.0 (korrigiert, vorher MIT) | Audio-Text-Embeddings |
| `mert-v1-330m` | m-a-p/MERT-v1-330M | `5240c2708a5acaee1007f43fb9735c7dcd0b78c9` | 3 GB (Manifest) | **CC-BY-NC-4.0** (korrigiert, vorher CC-BY-NC-SA-4.0) | Musik-Embeddings; bei kommerzieller Nutzung streichen |
| `ast-audioset` | MIT/ast-finetuned-audioset-10-10-0.4593 | `f826b80d28226b62986cc218e5cec390b1096902` | 3 GB (Manifest) | BSD-3-Clause (korrigiert, vorher MIT) | Klang-Klassifikation (AudioSet) |
| `songformer` | ASLP-lab/SongFormer | `a75880ed1b7375ac71860ec6c4fc9c899cf99515` | 2 GB (0,69 Mrd. Param., fp32 → bf16) | **unklar** | Song-Struktur (Intro, Strophe, Refrain) |
| `beat-this` | kein HF-Repo (GitHub CPJKU/beat_this) | **PIN-ERFORDERLICH** | 1 GB | MIT (Code); Gewichte unbelegt | Beat- und Downbeat-Tracking |
| `clip-vit-l14` | openai/clip-vit-large-patch14 | `32bd64288804d66eefd0ccbe215aa642df71cc41` | 2 GB (Manifest) | MIT | Bild-Embeddings zum Wiederfinden vorhandener Bilder/Videos (keine Generierung) |
| `essentia` | essentia (CPU) | `cpu-cache` | 0 GB | AGPL-3.0 (akzeptiert) | Messwerte (BPM, Tonart, Lautheit) auf der CPU |

Summe ca. **40 GB**, Reserve ca. 2 GB (Betreiber-Annahme: 35,5 GB, Reserve 6,5 GB).

- **Parameter:** bf16; Qwen3-ASR im Streaming-Modus. Optional, nicht eingeplant: `Qwen/Qwen3-ForcedAligner-0.6B` (`c7cbfc2048c462b0d63a45797104fc9db3ad62b7`, Apache-2.0, 0,92 Mrd. Param., ca. 2 GB) für Wort-Timestamps.
- **Begründung:** Qwen3-ASR ersetzt whisper-large-v3 (Streaming statt Batch). MOSS-Audio ersetzt qwen2-audio-7b. community-1 ersetzt speaker-diarization-3.1. SongFormer und beat_this liefern Struktur und Raster, die bisher fehlten.
- **Risiken:**
  - Die Betreiber-Summe 35,5 GB passt nicht zu den HF-Parameterzahlen: MOSS-Audio-8B-Instruct hat 9,05 Mrd. Parameter, also 18,1 GB nur für die Gewichte. Mit ca. 2 GB Reserve und 4 Nutzern ist ein OOM möglich. Ausweichen, falls die Messung das bestätigt: MOSS-Audio-4B-Instruct (existiert laut HF-API) oder MERT streichen (−3 GB).
  - MOSS-Audio braucht Repo-Code (`custom_code`, `trust_remote_code`) bzw. den SGLang-Fork des Herstellers. Unsere Runtime lädt Repo-Code standardmäßig **nicht** (siehe `test_llm_trust_remote_code.py`); die Entscheidung fällt in FLEET-P1-003.
  - Ein Repo `OpenMOSS-Team/MOSS-Audio-8B` ohne Suffix gibt es laut HF-API nicht. Eingetragen ist die Instruct-Variante.
  - pyannote.audio 4.x hat eine andere API als 3.1. Das Repo ist gated: HF-Bedingungen akzeptieren, `HF_TOKEN` nötig.
  - SongFormer: Lizenz **unklar** (kein HF-Lizenz-Tag, das README zeigt ein CC-BY-4.0-Badge). Das Repo verweist auf MuQ (`muq_config2.json`); dessen Lizenz ist ungeprüft.
  - beat_this hat kein HF-Repo. Die Gewichte kommen über `CHECKPOINT_URL` von `cloud.cp.jku.at`. Der Pod läuft offline, also müssen sie gepinnt (Commit + SHA-256) und in R2 gespiegelt werden. Die GitHub-API war aus dieser Umgebung nicht erreichbar, deshalb steht `PIN-ERFORDERLICH` im Manifest (Ticket FLEET-P1-005).
  - clip-vit-l14 steht im Manifest, aber in keiner Rolle, und hat keinen Handler (das task-Feld `agent.orchestrate` passt nicht). Vermerkt als `pendingRole` (FLEET-P1-005).
- **Bleibt ausgerollt bis Ablösung:** whisper-large-v3 (FLEET-P1-002), qwen2-audio-7b (FLEET-P1-003), pyannote-diarization 3.1 (FLEET-P1-004).

### RP3 music (bei AI-Generierung)

| Modell (ID) | HF-Repo | Revision | VRAM (Schätzung) | Lizenz | Funktion |
|---|---|---|---|---|---|
| `acestep-v15-xl-sft` | ACE-Step/acestep-v15-xl-sft | `d06de46b4622f781cf07f4a013a67d591ca52819` | 10 GB | MIT | Track generieren (`music.generate`, `/api/voice/song`), Remix |
| `acestep-v15-xl-turbo` | ACE-Step/acestep-v15-xl-turbo | `d4a0b288b83ebb7e25a8c0b32c573c22e134e8ee` | 10 GB | MIT | Drop/Übergang in 8 Schritten (`music.drop`) |
| `acestep-5hz-lm-4b` | ACE-Step/acestep-5Hz-lm-4B | `0a3ec94b557aea7d508da38b31cfe7341f6ff737` | 9 GB (4,19 Mrd. Param. bf16) | MIT | LM-Planer, Repaint, Lyrics |
| `acestep-v15-shared` | ACE-Step/Ace-Step1.5 (nur `vae/`, `Qwen3-Embedding-0.6B/`) | `19671f406d603126926c1b7e2adc169acbcade22` | 2 GB | MIT | gemeinsames VAE und Text-Encoder der XL-Modelle |
| Reserve `vllm-kv-cache-lm-4b` | – | – | 6 GB | – | KV-Cache des LM-Planers unter vLLM |

Summe ca. **37 GB**, Reserve ca. 5 GB.

- **Parameter:** Die XL-Repos liegen in **fp32** (4,99 Mrd. Parameter, ca. 20 GB je Modell), deshalb **bf16 erzwingen** (ca. 10 GB). Für vLLM wird `gpu_memory_utilization` hart gedeckelt; Zielwert ca. **0,33** der A40 (ca. 15 GB inkl. KV-Cache). Ohne Deckel reserviert vLLM standardmäßig 90 % der Karte und verdrängt die DiT-Modelle. Der Wert 0,33 ist eine **Schätzung**.
- **Raus:** `bark-small` (Gesang läuft über die ACE-Step-Lyrics) und `stable-audio-3-medium`.
- **Konfiguration:** `music.generate` in `src/core/ai/orchestrator/mcpRuntime.ts` zeigt auf `acestep-v15-xl-sft` (vorher xl-base). `roles.music.preloadModels` im Manifest enthält xl-base nicht mehr. In `roles.music.models` bleibt es stehen, damit der Serverless-Weg für LEGO bis FLEET-P1-009 erreichbar bleibt.
- **Risiken:**
  - `acestep_context_task` lädt über `AceStepHandler` mit `project_root=/app/acestep`. Ob das Image das Paket `acestep` und die Checkpoints (VAE, Text-Encoder) enthält, ist **unbelegt**; in den Dockerfiles gibt es keinen Treffer. Ohne Spiegel von `acestep-v15-shared` fehlen VAE und Text-Encoder auf dem Pod (offline, `HF_HUB_OFFLINE=1`). Ticket FLEET-P1-010.
  - Gesang über ACE-Step-Lyrics existiert noch nicht als `sing`-Pfad. `/api/voice/sing` nutzt weiter bark-small, deshalb bleibt bark-small bis FLEET-P1-010 ausgerollt.
- **Bleibt ausgerollt bis Ablösung:** bark-small (FLEET-P1-010).

### RP4 voice + LEGO (bei AI-Generierung)

| Modell (ID) | HF-Repo | Revision | VRAM (Schätzung) | Lizenz | Funktion |
|---|---|---|---|---|---|
| `qwen3-tts-17b` | Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice | `0c0e3051f131929182e2c023b9537f8b1c68adfe` | 8 GB (Manifest) | Apache-2.0 | TTS mit 9 Premium-Stimmen |
| `qwen3-tts-voicedesign` | Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign | `5ecdb67327fd37bb2e042aab12ff7391903235d3` | 8 GB (Manifest) | Apache-2.0 | Stimmdesign per Beschreibung |
| `qwen3-tts-06b-base` (**neu**) | Qwen/Qwen3-TTS-12Hz-0.6B-Base | `5d83992436eae1d760afd27aff78a71d676296fc` | 3 GB (0,91 Mrd. Param. bf16) | Apache-2.0 | Stimm-Cloning aus Referenz-Audio |
| `moss-soundeffect-v2.0` (**neu**) | OpenMOSS-Team/MOSS-SoundEffect-v2.0 | `e35df4d82fbe87fcd5d14e5d100e349c0c3c076d` | 5 GB (1,42 Mrd. Param., fp32 → bf16) | Apache-2.0 | Geräusche/SFX; ersetzt stable-audio-open-1.0 |
| `acestep-v15-xl-base` | ACE-Step/acestep-v15-xl-base | `220c1166efbdd9583eafcb12eb160594bbfcb241` | 10 GB | MIT | LEGO, extract, complete |
| `acestep-v15-shared` | ACE-Step/Ace-Step1.5 | `19671f406d603126926c1b7e2adc169acbcade22` | 2 GB | MIT | VAE + Text-Encoder für xl-base |

Summe ca. **36 GB**, Reserve ca. 6 GB (Betreiber-Annahme: 34 GB, Reserve 8 GB; die 2 GB Differenz sind VAE + Text-Encoder, die xl-base auch auf RP4 braucht).

- **Parameter:** bf16 (der Manifest-Eintrag von VoiceDesign stand auf fp16 und ist korrigiert; `handlers.qwen3_tts` lädt auf CUDA ohnehin bf16). Für MOSS-SoundEffect einen **torch.compile-Warmup beim Pod-Start** einplanen, sonst ist die erste Anfrage langsam. **TTS hat Vorrang vor LEGO**, ein LEGO-Lauf darf unterbrochen werden.
- **Raus:** htdemucs aus voice. Es steht nicht mehr im Preload von `roles.voiceGen`, bleibt aber in `roles.voiceGen.models`, weil der stems-Pod über `aiRole: voiceGen` läuft.
- **Ausgerollt seit 2026-10-12:** `acestep-v15-xl-base` steht in `pod-fleet.json` beim Pod voice (36 GB ausgerollt).
- **Risiken:**
  - Der Manifest-Eintrag für MOSS-SoundEffect fehlte; er ist jetzt angelegt (Status `neu`). Wie groß der Textencoder ist, ist unbelegt.
  - Routing seit 2026-10-13 (FLEET-P1-009, nur Pod-Modus): `song` mit aceTask lego/extract/complete bzw. Modell xl-base geht an RP4 (`podRoleFor('music', 'song', model, input)`); sft/turbo und `repaint` bleiben auf RP3. Serverless unverändert (Rolle music).
  - **Widerspruch offen:** `music.repaint` nimmt ohne `model` das Default `acestep-v15-xl-base` (musicContextTools.ts), geht aber an RP3, wo xl-base nicht ausgerollt ist. Entscheid nötig: Default auf sft oder repaint mit xl-base auf RP4.
  - Kontextspuren: der Server löst sie aus der Bibliothek auf und schickt sie als `contextAudio` (Base64) mit; `handlers_runpod.acestep_context_task` mischt sie zu `src_audio`. Live nicht belegt (Image ohne `acestep`, FLEET-P1-010).
- **Bleibt ausgerollt bis Ablösung:** stable-audio-open-1.0 (FLEET-P1-008).

### RP5 stems (beim stemMONK)

| Modell (ID) | Quelle | Revision | VRAM (Schätzung) | Lizenz | Funktion |
|---|---|---|---|---|---|
| `bs-roformer-sw-6stem` | FractalSurfer/BS-RoFormer-SW-6stem | `2b98254b19bdab07ce225d884ec4aa9dd8aafce1` | 6 GB | **UNGEKLÄRT** (HF `license:unknown`) | 6 Stems: bass, drums, other, vocals, guitar, piano |
| `scnet-xl-ihf` | GitHub ZFTurbo/Music-Source-Separation-Training, Release v1.0.15 | **PIN-ERFORDERLICH** | 3 GB | MIT (Code); Gewichte auf MUSDB18-HQ trainiert | Fallback bei kommerzieller Nutzung |
| `mel-roformer-karaoke` | becruily/mel-band-roformer-karaoke | `0c149975cfaa261c7d87baf54330a9da85bcf888` | 3 GB | unklar (kein Tag) | **nur auf Wunsch**: Lead- und Backing-Vocals trennen |
| `mel-roformer-dereverb` | anvuew/dereverb_mel_band_roformer | `cef05ad2b5b3145ea5c149d3ad5d1f8439b34d06` | 3 GB | GPL-3.0 | **nur auf Wunsch**: Hall entfernen |
| `beat-this` | GitHub CPJKU/beat_this | **PIN-ERFORDERLICH** | 1 GB | MIT (Code) | Raster für Warp/Time-Stretch |

Summe ca. **10–16 GB**: 10 GB für den Grundbetrieb, 16 GB mit Karaoke und Dereverb.

- **Inferenz-Code:** ZFTurbo/Music-Source-Separation-Training (MSST, MIT; Lizenz im GitHub-Repo gelesen).
- **5 Stems per Crossover** (AGENTS.md #11):
  - Gesang = `vocals`
  - Melodie = `guitar` + `piano`
  - Lows = `bass` + `drums` unterhalb ca. 150 Hz
  - Mids und Highs = der Rest (`other` und die Anteile von bass/drums oberhalb ca. 150 Hz), getrennt per **Linkwitz-Riley 4. Ordnung bei ca. 2,5 kHz**
  - Die Grenzfrequenzen sind Vorgaben, nicht gemessen.
- **Wichtiger Befund (Ist-Zustand):**
  - Die Manifest-ID `htdemucs-6s` verspricht 6 Stems, zeigt aber auf `dokodesuka/htdemucs_ft`, das 4-Stem-Fine-Tune.
  - `handlers_runpod.py` Zeile 497 lädt `Separator(model="htdemucs")`. Repository und Revision des Manifests werden dabei ignoriert; die Gewichte kommen aus dem demucs-Paket.
  - Der Kommentar dort nennt fp32, der Manifest-Eintrag fp16.
  - Der Alias `htdemucs-6s` bleibt, bis der RP5-Handler existiert (FLEET-P1-006).
- **Risiken:**
  - Die Gewichte von BS-RoFormer SW haben **keine Lizenz**: Das HF-Repo ist ein Spiegel von `enerjazzer/BS-ROFO-SW-Fixed`, das Konto des Urhebers ist gelöscht. Das reicht nur für privat/Forschung.
  - Das Repo wurde zuletzt am 2026-10-05 geändert, also sehr frisch. Der SHA-256 des Checkpoints steht im README (`24e7d35e…916e`) und muss beim Spiegeln geprüft werden.
  - SCNet XL IHF trennt nur **4 Stems** (bass, drums, vocals, other). Im Fallback fehlt die Melodie (guitar + piano), Melodie und Mids fallen dann zusammen.
  - Die SCNet-Gewichte sind auf MUSDB18-HQ trainiert; die Datensatz-Lizenz ist für kommerzielle Nutzung nicht geprüft.
  - Dereverb ist GPL-3.0.
- **Bleibt ausgerollt bis Ablösung:** htdemucs-6s (FLEET-P1-006).

## VRAM-Bilanz (nutzbar 42 GB je 48-GB-Karte, alles Schätzungen)

| Pod | ausgerollt (pod-fleet `models`) | Zielbild (Entscheid 2026-10-12) | frei im Zielbild |
|---|---|---|---|
| RP1 brain | 29 | unverändert (Zielbild-Wert 36, Widerspruch s. o.) | – |
| RP2 ears | 26 | 40 | 2 |
| RP3 music | 31 | 37 | 5 |
| RP4 voice + xl-base | 36 | 36 | 6 |
| RP5 stems | 8 | 16 | 26 |

Kosten: 5 A40-Pods, nur in Betrieb nach Trigger; Grenze AI_MAX_AI_EUR_PER_HOUR = 4 €/h (5 × 0,49 $ ≈ 2,25 €/h).

## Ausdrücklich unbelegt

1. **VRAM:** Alle Werte sind Schätzungen. Es gibt keine A40-Messung, keine Spitzenlast und keinen Lauf mit 4 Nutzern (FLEET-P1-011).
2. **`gpu_memory_utilization` ≈ 0,33** für den LM-Planer ist eine Schätzung.
3. **Lizenzen:**
   - SongFormer unklar, ebenso die MuQ-Abhängigkeit.
   - beat_this: Lizenz der Gewichte offen.
   - BS-RoFormer SW: keine Lizenz.
   - Mel-RoFormer Karaoke: kein Lizenz-Tag.
   - SCNet: Lizenz der Trainingsdaten offen.
4. **Pins:** beat_this und SCNet XL IHF haben kein HF-Repo. Die Revision ist `PIN-ERFORDERLICH`; es wurde kein Hash erfunden.
5. **Paket und Checkpoints:** Ob das Runtime-Image `acestep` und die ACE-Step-Checkpoints enthält, ist offen.
6. **Textencoder von MOSS-SoundEffect:** Größe unbelegt.
7. **Crossover-Frequenzen:** 150 Hz und 2,5 kHz sind Vorgaben, nicht am Material geprüft.
8. **Lauffähigkeit:** Keiner der neuen Handler existiert. Nichts davon ist auf einem Pod gelaufen.

## Offen (Umsetzung)

- FLEET-P1-001: Start-Trigger im Code umgesetzt (2026-10-13, gemockt getestet); offen: Live-Beweis mit echter Flotte, Pods nach Session-Ende stoppen, Widerspruch RP1 entscheiden.
- FLEET-P1-002 bis FLEET-P1-010: Handler und Ablösungen je neuem Modell (siehe MASTERTODOENDE.json/FINALEAUFGABEN.json).
- FLEET-P1-011: A40-VRAM-Messung (Spitze je Pod, 4 Nutzer).
