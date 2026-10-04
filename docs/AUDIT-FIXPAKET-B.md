# AUDIT-FIXPAKET-B — SSOT-Nachzug + Doku-Fixes

**Stand:** 2026-09-29 · Repo-only (lokale Commits, nichts gepusht) · Basis: HEAD `9016a7c`

## 1. SSOT-Nachzug (`MASTERTODOENDE.json`)

- Header auf HEAD gezogen: `generatedAt` 2026-09-29T15:58:00+00:00, `commit: 9016a7c`
  (war `e3cdb5f` / 2026-09-24 — e3cdb5f war der letzte SSOT-Commit, 52 Commits alt).
- **Neue Einträge** (je mit Beleg-Block, historische Einträge nicht angetastet):
  - `INFRA-RUNPOD-014` (P1/OPEN): imageHq-Vertrag worker-comfyui + Workflow-Input,
    Commit `b90f7a8` — Commit-Datum 2026-09-28 13:48 (im Code „SEIT 2026-09-27"),
    Beleg `src/core/ai/vision/runpodVision.ts:7-16, :201-205`.
  - `INFRA-RUNPOD-015` (P1/OPEN): **Deploy-Default-Drift** — `PREBUILT_IMAGES["FLUX_DEV"]`
    + `ROLE_DEFAULTS.imageHq` (`scripts/runpod-deploy.py:271, :140-144`) und Gate-Test
    `tests/test_runpod_deploy_defaults.py:61-63` halten das PrunaAI-Image → Redeploy-Risiko;
    Ziel-Image `runpod/worker-comfyui:5.11.0-flux1-dev-fp8` (VISUAL_LORA_STACK.md:64);
    Fix gehört zu Paket C1 (AUDIT-RESTTODOS.md).
  - `INFRA-RUNPOD-016` (P2/OPEN): imageLora-Vorratslauf — Werkzeuge `fa7dbf9`, BEFUND
    `9f6ea8f` (bei 1061/2080 gestoppt; Prämisse widerlegt: Motiv/Prompt bestimmt das Bild,
    LoRAs modulieren nur; OOM-Befund; Endpoint trug bei Messung noch das PrunaAI-Image).
  - `INFRA-RUNPOD-017` (P2/DONE): FLUX.1-dev komprimiert (FP8) statt FLUX.2 [dev],
    Commit `14113b7` (2026-09-29, 13 Dateien), 48-GB-Begründung.
  - `INFRA-RUNPOD-018` (P3/OPEN): Deploy-Workflow-Idempotenz — `save_template()` unique-sicher
    (`runpod-deploy.py:385-455`), Deploy-Run `36580686816` belegt lebendigen Pfad
    (AUDIT-RESTTODOS.md:13); Ergebnis-Verifikation gegen die Flotte steht aus.
  - `LEGAL-P0-001` (P0/**DONE** — dokumentiert): FLUX.1-dev-Derivate (cosmic-r16-LoRA,
    erzeugte Bilder). **Betreiber-Erklärung 2026-09-29:** „reine private/Forschungs-App,
    keinerlei kommerzielle Absichten". Konsequenz: BFL Non-Commercial-Lizenz deckt die
    Derivate solange nicht-kommerziell. **Wiedervorlage-Trigger** drin: sobald
    Kommerzialisierung von anunnakitools.de oder der Visual-Pfade geplant ist.
    Referenz: `docs/VISUAL_LORA_TRAINING.md:682`.
- **Korrekturen am Altbestand** (Altstände bleiben als Historie im Feld):
  - `visionLive`: worker → `runpod/worker-comfyui:5.11.0-flux1-dev-fp8` (Workflow-Vertrag),
    Template 35rilgx8er, Modell flux1-dev FP8, Kosten/Idle → 120 s — alles mit
    „Stand 2026-09-29"-Datum + Verweis auf b90f7a8/14113b7; Messwerte vom 2026-09-13 bleiben.
  - `budget.runpodCurrentImage`: PrunaAI-Segment → worker-comfyui (vorheriger Stand genannt).
  - `budget.runpodIdleTimeouts`: Korrektur-Nachtrag 120 s (gemessen 2026-09-16), 900-s-Werte
    als Historie markiert.
- **Duplikat-ID:** P3-Variante von `INFRA-HETZNER-016` („Flotte ist AUS", ~Z.3126) →
  `INFRA-HETZNER-016a` umbenannt (mit Umbenennungs-Note); P1-Variante (ufw/TURN) behält die ID.

## 2. Einzel-Fixes

- **„Toter Beleg-Hash" 5a1fc69c → 6c66a6f: NICHTS zu fixen.** Befund-Check: `5a1fc69c`
  kommt in der SSOT genau 2× vor, beide Male als Präfix der Cloudflare-**Zone-ID**
  `5a1fc69c28aacfed10a3c239cf138ba7` (PROD-P0-F1 note/evidence) — das ist kein Commit-Hash.
  Der Commit-Verweis in PROD-P0-F1 steht bereits korrekt auf `6c66a6f` („Code-Teil 2026-09-20,
  6c66a6f"); `git cat-file -t 5a1fc69c` scheitert, `6c66a6f` existiert (Merge F1). Die
  ursprüngliche Meldung hatte die Zonen-ID als Hash verlesen. Eine Ersetzung hätte die
  Zone-ID korrumpiert — bewusst unterlassen.
- **`docs/INFRA_KONSTITUTION.md`:**
  - Stand-Zeile → 2026-09-29 (Korrekturvermerk, Grundlagen 2026-09-20 bleiben).
  - Kostenmodus-Tabelle (Z.57-58): 0,49-€-Pauschale → reale Pools: AMPERE_48 ~0,40 $/h
    (A6000-Klasse, Plan), ADA_24 1,10 $/h (RTX 4090) / 1,58 $/h (5090) — Quelle
    `model_manifest.json` `gpuPoolNote`.
  - Vollast-Rechnung (§3) auf Rollen/Pools umgestellt (~2,3 $/h + Hetzner); Altstand benannt.
  - Idle-Timeout: 900 s → **120 s** (gemessen 2026-09-16) in §3 und als Korrektur-Blockquote
    hinter der Visual-Regel; `AI_VISUAL_IDLE_MS` (App-Wake-Fenster, 900 s) davon abgegrenzt.
- **`docs/runpod-8-instances-complete-plan.md:381`:** `MODELS_PRELOAD=flux2_fp8` →
  `flux1-dev-fp8` + Korrekturkommentar (60 Zeilen unter der Entscheidungs-Blockquote vom 29.09.).

## 3. Verifikation

- `python3` Round-trip: Datei war bereits kanonisch (indent=2), Re-Serialize byte-identisch
  → Diff enthält nur echte Änderungen.
- `json.load` OK; 186 Einträge (180 + 6); keine doppelten IDs mehr (016/016a getrennt);
  Statusvokabular unverändert (DONE/OPEN/PARTIAL); neue Einträge mit `area` + `priority` (kein `prio`).
- `git diff --stat` und Test-Gegenprobe: siehe Commit-Messages.

## 4. Nicht angefasst (wie beauftragt)

- Naming-Renaming-Historie, `docs/audit-infra-*.md` (Belegcharakter), Paket-A-Themen,
  PROD-P0-F1-Zonen-ID, alles Live-/RunPod-seitige.
