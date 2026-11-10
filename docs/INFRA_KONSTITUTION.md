# RunPod-Infrastruktur-Konstitution

**Einzig gueltige GPU-Konfiguration:** [pod-fleet.json](../deploy/runpod/pod-fleet.json). **Einzig gueltige aktive Modell-Registry:** [model_manifest.json](../services/audiomonastry-ai-runtime/model_manifest.json). Acht Rollen auf acht GPU-Instanzen.

**Neue harte Kostenregel: maximal 8,00 EUR/h fuer alle RunPod-Instanzen ZUSAMMEN**, einschliesslich budgetiertem Steuerfaktor und Kostenpuffer. Keine USD/h-Grenze je einzelne GPU. Vor Start reale RunPod-Angebote kontrollieren und GPU-Test-Gates bestehen; GPU-Verfuegbarkeit ist nicht garantiert.

Hetzner App, SFU, Medienserver, Edge, R2 und Supabase bleiben unveraendert.
