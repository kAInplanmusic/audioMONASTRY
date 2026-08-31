# HF Endpoint Deployment Plan – audioMONASTRY / SampleMONK

> Phase-0-Dokument (2026-08-31). **UPDATE GPU-Konsolidierung:** Umgesetzt –
> es existiert nur noch EIN GPU-Endpoint (`samplemonk-ai`, A100). Die früheren
> Einzel-GPU-Endpoints `samplemonk-ai-pilot` (Whisper) und `samplemonk-ai-clap`
> (CLAP) sind deaktiviert und laufen im gemeinsamen Custom-Container.
> Ziel: Hugging Face als **AI-Power-Layer** über einen eigenen, reproduzierbaren
> HF-Inference-Endpoint betreiben – **ohne** die bestehende Infrastruktur zu
> ersetzen:
>
> - **Hetzner** bleibt App-/Backend-/SFU-/Mastering-Flotte
> - **Supabase + R2** bleiben Datenbank-/Persistenz-Schicht
> - **Replicate** bleibt Primärpfad für Stem-Separation (Pay-per-Use, verifiziert)
> - **Hugging Face** erweitert um Audio-/Musik-/Multimodal-Inferenz
>
> Alle Preise sind Recherche-Stand Aug 2026 und werden vor Deployment im
> HF-Dashboard live verifiziert. **GPU-Wechsel nur mit expliziter Freigabe.**

---

## 1. GPU-Auswahl (Performance pro Euro, nicht maximale Leistung)

| GPU | VRAM | Preis (HF Endpoint) | €/h ca. | Performance/€ | Cold Start | Verfügbarkeit | Bewertung |
|---|---|---|---|---|---|---|---|
| T4 | 16 GB | $0.50 (AWS/GCP) | 0,46 € | hoch für kleine Modelle | schnell | sehr gut | zu klein für Alle-Modelle-Betrieb |
| L4 | 24 GB | $0.80 (AWS) / $0.70 (GCP) | 0,74 € | **sehr hoch** | schnell | sehr gut | zu klein für Alle-Modelle-Betrieb |
| A10G | 24 GB | $1.00 (AWS) | 0,92 € | hoch | schnell | gut | zu klein für Alle-Modelle-Betrieb |
| A10G ×4 | 96 GB | $5.00 (AWS) | 4,60 € | mittel | mittel | auf Anfrage | Budget-Obergrenze; 3×A10G existiert **nicht** (nur 1×/4×) |
| L40S | 48 GB | $1.80 (AWS) | 1,66 € | hoch | mittel | gut | **2×L40S existiert nicht** (nur 1×/4×/8×); 1×48 GB < ~53 GB Bedarf |
| **A100 80 GB** | 80 GB | **$2.50 (AWS)** / $3.60 (GCP) | **2,30 €** | **sehr hoch (80 GB!)** | mittel | gut | ✅ **ENTSCHEIDUNG: Standard-Endpoint** |
| H100 | 80 GB | $4.50 (AWS) / $10.00 (GCP) | 4,14 € | mittel | mittel–lang | neu/limitiert | Nur falls A100 je nicht reicht (mit Freigabe) |
| H200 | 141 GB | $5.00 (AWS) | 4,60 € | hoch | mittel–lang | neu/limitiert | Nur bei >80-GB-Bedarf (mit Freigabe) |

**Budget-Vorgabe:** max. **4–5 €/h**.

### 1.1 Entscheidung (Betreiber-Freigabe 2026-08-31)

> **1× A100 (80 GB, AWS, $2.50/h ≈ 2,30 €/h) inkl. CPU der Instanz** als Standard-Endpoint.
> **Kein Scaling nach oben, solange die A100 nicht nachweislich nicht reicht.**

Begründung:
- Betreiber-Schätzung: **~53 GB** für alle gewünschten GPU-Modelle gleichzeitig
  (manche häufiger, manche seltener genutzt – aber alle resident). Das passt
  **ohne Probleme in 80 GB** (inkl. Aktivierungs-/Overhead-Puffer).
- **2×L40S + CPU gibt es bei HF Endpoints nicht** (L40S nur 1× 48 GB / 4× 192 GB /
  8× 384 GB). 1×L40S (48 GB) wäre zu knapp unter 53 GB.
- A100 liegt mit 2,30 €/h deutlich unter dem Budget (4–5 €/h) und ist die
  günstigste Karte mit ≥ 80 GB.
- **CPU-Erweiterung:** HF-GPU-Instanzen bringen CPU + System-RAM mit. Die
  CPU-Modelle der ersten Liste (MERT, CLAP, AST, MMS-TTS, Whisper-/MusicGen-
  CPU-Fallback) laufen im selben Container auf der Instanz-CPU.
  Falls der System-RAM nicht reicht: **optionaler HF-CPU-Endpoint**
  (`intel-spr`, ~$0.033/h ≈ 0,03 €/h) oder Hetzner `ai-1`.
- **Gesamtkosten A100 + CPU:** **$2.50/h + $0.033/h ≈ $2.53/h ≈ 2,33 €/h**
  → weiterhin deutlich unter dem Budget.
- Fallback nur für den Beschaffungsfall (A100 im Ziel-Cloud-Anbieter nicht
  verfügbar): **A10G ×4** (96 GB, 4,60 €/h).

### 1.2 Alle Modelle gleichzeitig – kein Einzeltest-Betrieb

- **Kein L4-/Einzelmodell-Pilot.** Der Endpoint startet direkt mit A100 und
  lädt **alle** GPU-Modelle der Capability Matrix beim Hochfahren (Eager-Load);
  die CPU-Modelle laufen auf der Instanz-CPU (siehe Matrix §5).
- **Model Manager** hält alle GPU-Modelle resident; entladen wird nur bei
  echtem VRAM-Druck (Unload-Strategie `on-pressure`), nicht nach Idle.
- **Quantisierung:** kleine Modelle FP16; große (Bark, MusicGen-medium,
  Qwen-Omni) INT8, damit die ~53 GB sicher in 80 GB bleiben.
- **Concurrency ≤ 1 je Modell** (SampleMONK-Regel: kein unkontrolliert
  paralleler identischer Job).

---

## 2. Scale-to-Zero-Prinzip

```
INACTIVE → 0 GPU-Replicas → 0 GPU-Kosten
   ↓ AI REQUEST
ENDPOINT START (Container-Image vorhanden)
   ↓
MODEL INITIALIZATION (Gewichte aus HF-Hub-Cache)
   ↓
READY (Readiness-Probe grün)
   ↓
INFERENCE
   ↓
IDLE TIMEOUT (Vorschlag: 15 min)
   ↓
SCALE TO ZERO
```

**Wichtig:**
- Beim Hochfahren lädt der Model Manager **alle Modelle** (Eager-Load);
  `READY` wird erst, wenn alle Modelle geladen und der VRAM-Check grün ist.
- Während des Hochfahrens liefert HF **HTTP 502** → Client braucht Retry mit
  exponentiellem Backoff + Jitter (Vorschlag: 5×, 1/2/4/8/16 s).
- `minReplicas: 0` beibehalten (kein 24/7-Billing!). Nach dem Idle-Timeout
  fährt der Endpoint auf 0 Replicas; die Modell-Gewichte bleiben im
  persistenten Cache, nur die GPU-Runtime verschwindet.
- HF Endpoint benötigt **bezahltes Hub-Abo** (PRO $9/Monat) + Zahlungsmittel.

---

## 3. Modell-Daten-Strategie (keine Neuinstallation je Start)

| Schicht | Ablage | Konsequenz |
|---|---|---|
| Code + Dependencies | **Container-Image-Layer** (Dockerfile, pyproject, lock) | persistent, sofort da |
| Modell-Gewichte | **HF Model Repository / Artifacts**, geladen in `HF_HOME`-Cache auf persistentem Volume | einmal laden, danach Cache; **Revision-Pinning** (`@rev`) gegen Drift |
| Runtime | **ephemere GPU-Instanz** (scale-to-zero) | darf verschwinden |

- Kleine Modelle (<1 GB) dürfen zusätzlich ins Image gebacken werden.
- Große Modelle werden beim ersten Start aus dem Hub geholt und bleiben im
  persistenten Cache (kein erneutes Downloaden beim nächsten Scale-up).
- Keine manuelle Installation, keine `git clone`-Gewichte, keine losen
  `.bin`-Dateien im Repo.

---

## 4. Custom Container (`services/samplemonk-ai-runtime`)

Bevorzugte Zielarchitektur (ein Endpoint, ein Container):

```
Hugging Face Endpoint (GPU)
        │
        ▼
SampleMONK AI Runtime Container
        ├── Model Manager      (ModelDefinition, Lazy-Load/Unload, VRAM-Check)
        ├── Audio Runtime      (Demucs-lite, AST, Whisper, CLAP, MusicGen, TTS/Bark)
        ├── Multimodal Runtime (Qwen2.5-Omni – Phase 2+)
        ├── MCP Runtime        (Tool-Schema → bestehende pluginCommandRegistry)
        ├── Health Service     (GET /health, GET /ready, GET /models, GET /metrics)
        ├── Queue              (intern, 1 Job je Modell, Dedup-Hash)
        └── Inference API      (POST /infer mit task+model+payload, JSON)
```

**Reproduzierbarkeit (Phase 2-Artefakte):**
- `Dockerfile` (multi-stage, pinned base image, `HF_HOME=/data/hf-cache`)
- `pyproject.toml` + `requirements.lock` (exakte Versionen)
- `startup.sh` / Startup-Config (Modell-Manifest laden, Readiness erst nach
  erfolgreichem Init des Default-Modells)
- `GET /health` (Prozess lebt), `GET /ready` (Modell geladen & VRAM ok),
  `GET /models`, `GET /metrics`
- `model_registry.json` / `model_manifest.json` (alle ModelDefinitionen inkl.
  Revision-Pin, Task, VRAM-Min/Est, Load/Unload-Strategie, Concurrency)
- `runtime_config.yaml` (Idle-Timeout, Max-Jobs, Quantisierungs-Defaults)

**ModelDefinition (Entwurf, aus der Aufgabenstellung übernommen):**
```yaml
id: "whisper-large-v3"
repository: "openai/whisper-large-v3"
revision: "<pinned-commit>"
task: "transcribe"
estimatedVRAM: "5GB"
minimumVRAM: "4GB"
priority: 1
loadStrategy: "eager"        # alle Modelle werden beim Start geladen
unloadStrategy: "on-pressure" # entladen nur bei VRAM-Druck, nicht nach Idle
concurrency: 1
dependencies: []
inputFormats: ["wav", "mp3"]
outputFormats: ["json"]
```

---

## 5. Analyse-Pipeline (Monitoring, kein Auto-Scaling nach oben)

Der Orchestrator (Phase 1) und der Container sammeln Metriken:

- Cold-Start-Dauer, 502-Rate, Queue-Tiefe, Wartezeit
- Inferenz-Latenz p50/p95, VRAM-Auslastung, GPU-Utility
- Kosten/h (aktive Minuten), Jobs/Tag je Modell

**Grundsatz (Betreiber-Freigabe 2026-08-31):** Es startet **direkt mit A100**.
Es gibt **kein Scaling nach oben**, solange die A100 nicht nachweislich nicht
reicht. Die Pipeline überwacht nur und meldet:

| Schwelle | Bedeutung | Aktion |
|---|---|---|
| VRAM dauerhaft > 85 % | Modellsatz wächst | Bericht + Vorschlag (Quantisierung/Modell-Unload) |
| p95-Latenz über Zielwert | Modell zu langsam auf A100 | Bericht + Vorschlag (Optimierung) |
| Queue-Tiefe > 3 über 10 min | Durchsatz-Engpass | Bericht + Vorschlag (Freigabe für H100/H200 einholen) |

**Regel:** Vor jedem GPU-Wechsel wird eine kurze Kosten-/Nutzen-Begründung
vorgelegt; es wird **nichts automatisch hochskaliert**.

---

## 6. Concurrency-/Dedup-Regel (SampleMONK-Regel, verallgemeinert)

Bestehend (Stems, DCT-101): `STEM_MAX_JOBS`, 429 + `Retry-After`,
Idempotency-Key → 409, Timeout-Reset. Das wird in Phase 1 auf **alle**
AI-Jobs verallgemeinert:

- **SingleFlight je (task, model, payload-hash):** identische Anfrage während
  eines laufenden Jobs → gleiche Job-ID zurückgeben statt zweiten Job starten.
- **Limits je Task-Klasse:** z. B. `AI_MAX_JOBS_STEMS=2`,
  `AI_MAX_JOBS_GENERATION=1`, `AI_MAX_JOBS_ANALYSIS=2`.
- **Endpoint-seitig:** Model Manager erlaubt **1 Job je Modell** (Queue, kein
  zweites Laden derselben Gewichte).

---

## 7. Kostenbeispiele (A100 + CPU, Scale-to-Zero)

| Szenario | GPU/CPU | Aktive Zeit | Monatskosten ca. |
|---|---|---|---|
| Wenig Betrieb (alle Modelle resident, 1 h/Tag aktiv) | A100 + CPU | ~30 h/Monat | ~70 € + PRO 9 € |
| Regelbetrieb (4 h/Tag aktiv) | A100 + CPU | ~120 h/Monat | ~280 € + PRO |
| Dauerbetrieb Tagsüber (12 h/Tag) | A100 + CPU | ~365 h/Monat | ~845 € + PRO |
| 24/7 (minReplicas 1, NICHT empfohlen) | A100 + CPU | 730 h | ~1.700 € |

**Stundensatz bei aktiver Inferenz:**
- A100 (GPU): $2.50/h ≈ **2,30 €/h**
- Optionaler HF-CPU-Endpoint (`intel-spr`, falls Instanz-RAM nicht reicht): $0.033/h ≈ **0,03 €/h**
- **Gesamt: ~2,33 €/h** → unter dem Budget (max. 4–5 €/h).

Mit Scale-to-Zero (0 Replicas bei Inaktivität) entstehen Kosten nur für
tatsächlich aktive Minuten; die CPU-Modelle laufen bevorzugt auf der
Instanz-CPU der A100 (kein separater Endpoint nötig).

---

## 8. Offene Punkte / nächste Schritte

1. [ ] Lizenz-Verifikation (MusicGen/Bark/MMS/MERT) abschließen
2. [ ] Live-Preis-Check im HF-Dashboard (A100-Verfügbarkeit inkl. CPU/RAM-Spezifikation der Instanz, Ziel-Cloud AWS)
3. [ ] Phase 1 (Code): AI Orchestrator + Model Manager + ConcurrencyGuard
4. [ ] Phase 2: Custom Container `services/samplemonk-ai-runtime` (Eager-Load aller GPU-Modelle, CPU-Modelle auf Instanz-CPU)
5. [ ] Phase 3: Endpoint mit **1× A100 (80 GB) inkl. CPU** anlegen, Scale-to-Zero, Idle-Timeout; optional HF-CPU-Endpoint falls RAM nicht reicht
6. [ ] Phase 4: MCP-Tool-Schema über `pluginCommandRegistry`
