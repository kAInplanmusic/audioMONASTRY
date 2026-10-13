# AI-Korrektur 2026-10-07 · Produkt-AI nur lokal

> **Herkunft:** Zweiter Bericht dieser Sitzung (Chat), dauerhaft abgelegt.
> **Betreiber-Vorgabe (2026-10-07, wörtlich sinngemäß):** Die LLM läuft lokal auf Runpod mit **Qwen 3.8 quantisiert** (geplant), plus ggf. ein **kleines spezielles DAW-/Audiosteuerungsmodell**. Cloud-Anbieter waren nur fürs Programmieren und Testen und sollen im Endprodukt **nicht** hinterlegt sein. Einzige Ausnahme: optional **DeepSeek V4** als Notfall-Backup oder „zweites Augenpaar“.
> **Aufgaben:** `MASTERTODOENDE.json` → `RT-AUDIT-P1-014` (Isolation), `RT-AUDIT-P1-015` (Brain/Streaming/warm).

## Korrektur gegenüber dem Gesamtbericht

Der Router ist bereits auf „nur lokal“ voreingestellt: ohne `AI_ALLOW_EXTERNAL_LLM=true` lässt `LlmRouter.rankProviders()` nur `runpod-local` zu. Die im Gesamtbericht gemessenen LLM-Latenzen (DeepSeek, Cerebras, OpenRouter) betreffen nur die Entwicklungsumgebung. Der Punkt „AI nicht lokal, 50 %“ entfällt.

## Verbleibende Lücken zum Zielbild

| Bereich | Finding | Schwere | Fix |
|---|---|---|---|
| AI-Isolation | Orchestrator-`CerebrasProvider` (`providerRouter.ts:64`) läuft für Task `nlu` an der Lokal-Sperre vorbei, sobald `CB_API_KEY` gesetzt ist | 60 % | entfernen; `nlu` über lokales Brain |
| AI-Isolation | Sperre nur alles/nichts: `AI_ALLOW_EXTERNAL_LLM=true` öffnet Cerebras, OpenRouter, Mistral, PublicAI und DeepSeek zusammen | 55 % | Positivliste `AI_EXTERNAL_LLM_ALLOWLIST=deepseek-pro`, übrige Cloud-Provider aus dem Code |
| Brain-Laufzeit | Nativer Worker: HF-`transformers.generate()` fp16, vLLM nur per Build-Arg (`AI_INSTALL_VLLM=0`), kein Streaming | 55 % | vLLM-Pfad (OpenAI-kompatibel) als Standard, `stream: true`, int4 |
| Brain-Modell | Qwen 3.8 nicht im Brain-Manifest (nur `qwen3-30b-a3b-awq`, `qwen3-14b`, `qwen3-4b`); „qwen-3.8-27b“ nur als Cloud-Default für Cerebras | 40 % | Manifest-Eintrag mit gepinnter Revision, `awq-int4` |
| Kaltstart | `idleTimeoutSeconds: 15` bei Scale-to-Zero | 50 % | während aktiver Session ≥ 1 Worker warm (Fleet-Wake existiert) |
| Voice | Produktionsziel HF Inference Endpoint (`docker-compose.ai.yml`, `voiceRoutes`) | 40 % | Runpod-Rolle `voiceGen` |
| Stems | Replicate-Pfad (`stemRoutes.ts`, nur mit `STEM_AI_PROVIDER=replicate`) | 15 % | entfernen |

Hinweis aus `MASTERTODOENDE.json → liveState2026_09_11.runpodBrain`: Der live betriebene Brain-Endpoint lief bereits als **vLLM Qwen3-14B-AWQ**. Der native transformers-Pfad ist also der Rückfall, nicht zwingend der Live-Weg.

## Kleines DAW-Steuermodell

Platz existiert: `brainModelDefaults().executor` = `qwen3-4b`. Vorschlag: LoRA-Finetune auf `PLUGIN_COMMAND_CATALOG` + MCP-Werkzeugnamen; vLLM Guided Decoding (JSON-Schema der Kommandos), damit nur gültige Plugin-Befehle entstehen. Das große Qwen bleibt für Planung, DeepSeek V4 für die zweite Meinung.

## Nicht gemessen

Runpod-Brain (Kaltstart, TTFT, Tokens/s): kein `RUNPOD_API_KEY` in der Agent-Umgebung.
