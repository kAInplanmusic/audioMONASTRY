# audioMONASTRY – AI Cost Guide

> **Historischer Bericht — nicht die gültige RunPod-SSOT (2026-11-10).** Datierten Angaben zu GPU, Gewichtsspiegel, Rollen, Deploy, Preisen und damaliger Live-Prüfung nicht als aktuelle Fakten verwenden. **Aktive Referenz:** [RunPod Fleet SSOT](RUNPOD_FLEET_SSOT.md) mit `deploy/runpod/pod-fleet.json` und `services/audiomonastry-ai-runtime/model_manifest.json`: acht heterogene Pods (`brain`, `ears`, `voice`, `music`, `studio`, `audio-brain`, `song`, `vis`), RunPod-Gesamtbudget **8 €/h**. Historische Serverless-Bild-/Video-Rollen nicht deployen.


> Verbindliche Zahlen: siehe docs/INFRA_KONSTITUTION.md.

## Preisquellen (Stand 2026-08, live zu verifizieren)

| Position | Preis | Quelle |
|---|---|---|
| HF Endpoint A100 (AWS) | $2.50/h ≈ 2,30 €/h | huggingface.co/docs/inference-endpoints/pricing |
| HF CPU (intel-spr) | $0.033/h | ebd. |
| HF Hub PRO (für Endpoints) | $9/Monat | huggingface.co/pricing |
| Replicate Demucs | ~$0.05/Stem-Job | Modellseite `cjwbw/demucs` |
| HF Serverless LLM/Voice | Free-Tier, sonst PRO | huggingface.co/pricing |
| DeepSeek V4 Flash | $0.22–0.44/M in | api-docs.deepseek.com |

## Konfiguration

`AI_COST_*`-Variablen in `.env` (siehe `.env.example`). Implementierung:
`src/core/ai/orchestrator/costTracker.ts`.

## Berechnung

- `cost/session` = Summe aller Job-Kosten der Session.
- `cost/hour` = Kostenfenster der letzten Stunde.
- `cost/month` = Hochrechnung auf 30 Tage.
- GPU-Kosten: aktive Minuten × Stundensatz (per Minute abgerechnet).

## Beispiel (Scale-to-Zero, Burst)

- 4 h/Tag aktiv auf A100: ~120 h/Monat × 2,30 € ≈ 276 € + PRO 9 €.
- Inaktivität: 0 Replicas → 0 GPU-Kosten.
- Budget-Grenze: **max. 10 €/h** laufende Flottenkosten (Hetzner + RunPod
  zusammen), Zielband **5–7,5 €/h** (Betreiber-Vorgabe:
  `docs/INFRA_KONSTITUTION.md` §1). Stand 2026-09-20: die frühere Angabe
  „max. 4–5 €/h" ist überholt.

> **Stand 2026-09-20:** Die HF-Dedicated-Endpoints sind abgelöst; die
> GPU-Inferenz läuft auf **max. 8 RunPod-Rollen-Endpoints**. Die A100-Zeile oben
> beschreibt den historischen HF-Pfad (Preisquelle 2026-08). Kanonische
> Größenordnungen (`docs/INFRA_KONSTITUTION.md` §3): Vollast AI mit 8 Rollen
> ~3,3–4,0 €/h, nur Hetzner (AI aus) ~0,054 €/h, Speicher max. 5 €/Monat.
