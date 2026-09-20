# audioMONASTRY ONNX-Modelle
# ==========================
# Stand: 2026-09-07

## Installierte Modelle

### htdemucs.onnx (Stem-Separation)

- **Quelle:** Meta Research (htdemucs)
- **Funktion:** Split eines Audio-Tracks in 4 Stems: Vocals, Bass, Drums, Guitar
- **Größe:** ~291 MB (ONNX-Export `smank/htdemucs-onnx`)
- **Pfad:** `public/models/htdemucs.onnx` — GENAU dieser Pfad, weil der Client
  ihn unter `/models/htdemucs.onnx` lädt (`src/ai/localDemucs.ts`)
- **Benötigt:** WebGPU oder CPU (CPU fallback über `getGPUKernel()` → `null`)

## Download

```bash
# Modell herunterladen (einmalig, nach CI-Deployment) - EINE Quelle:
bash scripts/download-models.sh
# `download-htdemucs.sh` ist nur noch ein Alias darauf (vorher: toter
# GitHub-Pfad + falsches Zielverzeichnis, siehe Kopf des Skripts).

# Auf einen Flotten-Knoten bringen (read-only gemountet, ohne Image-Ballast):
bash scripts/hetzner/deliver-media.sh <knoten-ip>
```

## CI/CD

- In CI-Jobs (`build.yml`) kann `download-htdemucs.sh` optional ausgeführt werden
- Modell wird im Docker-Image eingebunden (Git LFS oder Download im Build)
- **Hinweis:** Git-Repository behält `.gitignore` für `public/models/*` → Modell **nicht** in Git

## Nutzung

```typescript
import { stemSeparate } from '@/services/ai-runtime/htdemucs';

// Split eines Audios
const stems = await stemSeparate(audioBuffer);
// Returns: { vocals: Float32Array, bass: Float32Array, drums: Float32Array, guitar: Float32Array }
```

## TODO

- [ ] ONNX-Modell in Docker-Image einbauen (Build-Schritt)
- [ ] `useModels` Hook für Online-Download (falls nicht im Build)
- [ ] Modell-Hash-Verifikation (Sicherheit)
