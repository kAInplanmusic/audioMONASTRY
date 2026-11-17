# audioMONASTRY – AI Cost Guide

> Verbindliche Zahlen: siehe docs/INFRA_KONSTITUTION.md.

## Preisquellen (Stand 2026-08, live zu verifizieren)

| Position | Preis | Quelle |
|---|---|---|
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

- GPU-Billing = tatsächlich aktive Vast.ai-Instanzstunden; Preise vor jeder Bereitstellung frisch prüfen.
- Inaktivität: keine gemieteten GPU-Instanzen; verbleibende Speicher- und Cloud-Services separat kalkulieren.
- Budget-Grenze: **max. 10 €/h** laufende Flottenkosten (Hetzner + RunPod
  zusammen), Zielband **5–7,5 €/h** (Betreiber-Vorgabe:
  `docs/INFRA_KONSTITUTION.md` §1). Stand 2026-09-20: die frühere Angabe
  „max. 4–5 €/h" ist überholt.

**Aktueller Budgetvertrag:** `deploy/gpu-provider.json` begrenzt die GPU-Flotte auf 8 €/h; Hetzner und Supabase sind davon ausdrücklich ausgenommen. Keine zusätzlichen GPU-Abos oder HF-Inference-Endpoints.
