# audioMONASTRY — Infrastruktur-Konstitution

## Verbindlicher RunPod-Stand: 9. November 2026

**RunPod SSOT:** [RUNPOD_FLEET_SSOT.md](RUNPOD_FLEET_SSOT.md). Die einzige ausführbare Flottenkonfiguration ist `deploy/runpod/pod-fleet.json`, die einzige Modell-/Gewichtsquelle `services/audiomonastry-ai-runtime/model_manifest.json`.

Es gibt **genau acht NVIDIA A40 (48 GB)**: die KI-Pods `brain`, `ears`, `voice`, `music`, `studio`, `audio-brain`, `song` und den aktivierten Render-Pod `vis`. 42 GB planbares VRAM je Pod (6 GB Marge), höchstens 6 €/h als RunPod-Budget, keine Serverless-Flotte und keine anderen aktiven Pod-/Modellvarianten. Preise und Verbrauch sind vor dem Start live zu prüfen. Diese Architektur ändert **keine** bestehende Hetzner-Instanz.

## Nicht-RunPod-Zuständigkeiten (unverändert)

- **Hetzner:** `app` (API, Frontend, Proxy), `sfu` (mediasoup), `media` (Mediencache/-streaming), `edge` (Monitoring), provisioniert über `scripts/hetzner/`.
- **Speicher und Daten:** R2 für Medien/Modelldateien, Supabase für strukturierte Projektdaten. Speichersystem, Snapshots und App-Deployment werden durch diese RunPod-SSOT nicht geändert.
- **Sicherheitsvorgaben:** Authentisierung/Tokens, Kill-Switch, Kostengrenzen, Snapshot-/Teardown-Schutz und Sitzungs-Integrität bleiben unverändert verbindlich.

Für operative Details außerhalb von RunPod gelten die jeweiligen Hetzner-, Security- und Audio-Engine-Runbooks. Es existiert keine zweite RunPod-Konstitution.
