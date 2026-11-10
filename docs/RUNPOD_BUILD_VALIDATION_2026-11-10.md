# RunPod: Image-Build und Laufzeitnachweise, 10. November 2026

## Ergebnis und Freigabegrenze

Die sechs beauftragten Gewichts-/Loader-Korrekturen sind implementiert und der
R2-Abgleich ist abgeschlossen. Ein echtes Runtime-Image wurde auf GitHub Actions
gebaut und nach GHCR gepusht. Eine erfolgreiche GPU-Inferenz aller 22 Modelle
auf acht Pods ist **nicht** nachgewiesen. Die Flotte ist damit nicht freigegeben.

## Tatsächlich ausgeführter Build

- Commit: `105874274ffcd02c9bbfd6c471db0a63d28cb353`.
- Image: `ghcr.io/kainplanmusic/audiomonastry-ai-runtime-runpod:105874274ffcd02c9bbfd6c471db0a63d28cb353`.
- [GitHub Actions Build 42890430118](https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/42890430118): erfolgreich.
- Build-/Push-Schritt und sämtliche nachfolgenden vorhandenen Prüfungen waren
  erfolgreich: Torch, Transformers/Worker-Import, Qwen3-Modelltyp, HF Hub,
  Soundfile/SciPy, Diffusers, Pyannote, Qwen TTS, Handler-Tabelle, Demucs,
  MoA-Registrierung und Torch-Mindestversion.
- Der Build aktiviert Audio-AI, Voice-AI, MSST, Basic Pitch und Pyannote 4.
- Der Deploy-Job wurde übersprungen. Es wurden keine bestehenden Endpoints
  umgestellt und keine GPU-Ressourcen angelegt.

Das ist ein Nachweis für dieses gemeinsame Image mit seinen Build-Schaltern,
kein Nachweis für acht vollständige Rollen-Images. Insbesondere aktivierte der
Build weder `AI_INSTALL_VLLM`, `AI_INSTALL_EARS_AI`, `AI_INSTALL_ACESTEP` noch
`AI_INSTALL_MOSS_SFX`. YuE2 und UniverSR werden im Dockerfile nicht installiert.
Ein zusätzlicher Image-Audit prüft ausgewählte tatsächlich benötigte Imports
und den Dispatch aller 22 Manifest-Einträge im gebauten Container.

## RunPod-Zugriff: reproduzierbarer Blocker

[Read-only Preflight 42891306323](https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/42891306323)
verwendete das bereits vorhandene Repository-Secret `RP_API_KEY` direkt in CI.
Der Schlüssel wurde weder ausgegeben noch aus CI exportiert.

Der erste Aufruf `GET https://api.runpod.io/v2/pods?includeClusterPods=true`
mit Bearer-Authentifizierung endete mit **HTTP 401**. Dieser Header entspricht
der am selben Tag abgerufenen offiziellen OpenAPI-v2-Spezifikation. Der Bericht
enthält `authenticated: false`, `readOnly: true`, `createdPods: 0`.
Damit sind Bestand, bestehender Flottenpreis und verfügbares GPU-Budget nicht
ermittelbar. Der gespeicherte R2-Zugang und der Supabase-Service-Schlüssel
ersetzen keinen RunPod-Control-Plane-Zugang.

Für die Fortsetzung wird ein von RunPod akzeptierter API-Schlüssel im
Repository-Secret `RP_API_KEY` benötigt. Danach zuerst den Preflight mit
`probe_only=true` ausführen. Unbekannte Kosten aktiver Worker erlauben keine
Budgetfreigabe. Maßgeblich bleibt das Gesamtlimit von 8 EUR/Stunde inklusive
konfiguriertem Wechselkurs, Steuerfaktor und Reserve.

## Verbleibende Arbeiten

1. Fehlende ausgewählte Inferenzpakete und kompatible Rollen-Images fertigstellen;
   Upstream-Abhängigkeiten nicht durch ungeprüfte `--no-deps`-Installationen umgehen.
   YuE2, Qwen TTS, ACE-Step und MOSS haben unterschiedliche Versionsanforderungen.
2. SonicMaster besitzt `audio.master` im Manifest; die Task-Normalisierung macht
   daraus `master`, aber dieser Handler ist nicht registriert. Das ist ein
   zusätzlicher Dispatch-Fehler; ein DSP-Fallback würde das Modell nicht ersetzen.
3. Mit gültigem RunPod-Zugriff Gesamtbudget und GPU-Verfügbarkeit prüfen, dann
   isolierte Testressourcen mit verlässlicher Abschaltung erstellen.
4. Reale kurze Inferenzaufträge pro Modell ausführen; Ausgabeformat, Nichtleere,
   NaN/Inf, Dauer, Pegel, Clipping, GPU-Spitzen und Laufzeiten dokumentieren.
5. Hörproben erstellen und bewerten. CPU-Imports, Readiness, erfolgreiche
   Gewichtsdownloads und Shape-Prüfungen ersetzen diesen Schritt nicht.

Die bisherigen echten CPU-/Checkpoint-Nachweise und die bekannte rote
Gesamtsuite stehen in `MODEL_WEIGHT_PROVISIONING_2026-11-10.md`; der vollständige
Bestandsnachweis steht in `R2_MODEL_AVAILABILITY_2026-11-10.md`.
