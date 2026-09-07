# audioMONASTRY ONNX-Modelle
# ==========================
# Stand: 2026-09-07

## Installierte Modelle

### htdemucs.onnx (Stem-Separation)

- **Quelle:** Meta Research (htdemucs)
- **Funktion:** Split eines Audio-Tracks in 4 Stems: Vocals, Bass, Drums, Guitar
- **Größe:** ~824 MB
- **Pfad:** `public/models/htdemucs/htdemucs.onnx`
- **Benötigt:** WebGPU oder CPU (CPU fallback über `getGPUKernel()` → `null`)

## Download

```bash
# Modell herunterladen (einmalig, nach CI-Deployment)
bash scripts/download-htdemucs.sh
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
