# audioMONASTRY – AI Cost Guide

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
- Budget-Grenze: max. 4–5 €/h bei aktiver Inferenz (Betreiber-Vorgabe).
