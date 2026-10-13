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

## Offene Punkte (Stand 2026-09-21)

- [x] Modell NICHT ins Docker-Image — bewusste Entscheidung: 291 MB Ballast in
      jedem Rollen-Image (app/sfu/master) waeren teuer und langsam. Stattdessen
      liefert `scripts/hetzner/deliver-media.sh` die Datei auf die Knoten und
      `docker-compose.media.yml` mountet sie read-only nach
      `/app/dist/models`; `deploy.sh` erkennt das Overlay und behaelt es.
- [x] Kein `useModels`-Hook noetig — der Client laedt das Modell direkt von
      `/models/htdemucs.onnx` (`src/ai/localDemucs.ts`), also von der laufenden
      App; ein zweiter Ladeweg haette nur eine weitere Fehlerquelle erzeugt.
- [x] Modell-Hash-Verifikation — `scripts/download-models.sh` prueft Groesse UND
      SHA-256 (Pin = LFS-OID der Quelle
      `d2b401f322558cd57d67a752ed7be3fa55178a0626011eda8ac7bb74e17280c0`,
      304 321 552 Bytes) und verschiebt die Datei erst nach bestandener Pruefung
      in den Produktionspfad. Trockenlauf: `--print-config`, reine Pruefung:
      `--verify-only` (z. B. im Preflight).
