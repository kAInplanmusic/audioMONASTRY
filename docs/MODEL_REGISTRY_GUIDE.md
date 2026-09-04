# audioMONASTRY – Model Registry Guide

## Quellen

1. **Kanonisch im Container:** `services/samplemonk-ai-runtime/model_manifest.json`
   (wird von der Python-Runtime geladen).
2. **TS-Spiegel:** `src/core/ai/orchestrator/modelRegistry.ts` (Orchestrator-Routing,
   VRAM-Planung, Tests).

Beide Dateien müssen bei Änderungen synchron gehalten werden.

## ModelDefinition (Pflichtfelder)

```yaml
id: "whisper-large-v3"          # eindeutig
repository: "openai/whisper-large-v3"
revision: "<commit-hash>"       # PFLICHT, kein latest
task: "audio.transcribe"
framework: "transformers"
estimatedVRAM: 5                # GB, FP16/INT8 je nach quantization
estimatedRAM: 6
loadPriority: 2                 # niedrig = früher laden
preload: true
loadClass: "CORE"               # CORE | FREQUENT | ON_DEMAND | RARE
quantization: "int8"
dependencies: ["transformers", "torch"]
inputFormats: ["wav", "mp3"]
outputFormats: ["json"]
maxDuration: 30
concurrency: 1                  # ≥ 1 (SampleMONK-Regel)
timeout: 120
license: "Apache-2.0"
```

## Regeln

- `revision` leer oder `latest` → Registry-Validierung schlägt fehl.
- Neues Modell: erst in `docs/HF_MODEL_CAPABILITY_MATRIX.md` bewerten
  (gewichteter Score ≥ 6,0, Lizenz ok, Risiko ≤ 4), dann Manifest + TS-Spiegel.
- VRAM-Summe CORE+FREQUENT muss unter Budget (80 GB) minus Safety-Margin (6 GB) bleiben.
