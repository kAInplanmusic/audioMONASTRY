# AI-Flotte – Konfiguration und Startbedingungen

Abgleich: 2026-11-13 UTC. Aktueller Produktionsbestand ausschließlich in
[SERVER_FLEET.md](SERVER_FLEET.md). Kein Start und keine Infrastrukturänderung
wurde im Rahmen dieses Abgleichs ausgeführt.

## Konfigurationsquellen

- `deploy/gpu-provider.json`: Provider `vast`, globale Regionssuche, 8 EUR/h
  Gesamtgrenze ohne Hetzner/Supabase, höchstens 28 Minuten Testlauf,
  Runtime-Übernahme erst nach Readiness.
- `deploy/gpu/pod-fleet.json`: Rollen und Modellzuordnung.
- `services/audiomonastry-ai-runtime/model_manifest.json`: Modellidentitäten.
- `scripts/gpu-pods.py`: aktiver Provider-Dispatcher. Die frühere RunPod-
  Starttabelle mit festen Immer-an-Triggern ist keine aktuelle Spezifikation.

Die Dateien beschreiben Konfiguration, keine nachgewiesene Produktion. Der
Planer kann Provider-Abfragen ausführen und lokalen Controller-State schreiben;
sein Aufruf ist keine rein lokale Live-Inventur.

## Vor einer gesondert autorisierten Inbetriebnahme

Gewichte, gepinnte Images, frische Angebote, vollständige Kosten einschließlich
Transfer sowie Secrets prüfen. Private Runtime-Adressen erst nach
authentifizierter Readiness und exaktem geladenem Modellinventar übernehmen;
anschließend echte Inferenz mit normalen Handler-Defaults und den separaten
Chromium/NVENC-Nachweis prüfen. Ein Containerstatus genügt nicht.

Der datierte Migrations-/Testverlauf steht in
[VAST_MIGRATION_STATUS_2026-11-11.md](VAST_MIGRATION_STATUS_2026-11-11.md);
Betriebskonzept und historische Bereinigungen in
[VAST_ON_DEMAND_BETRIEB_2026-11-12.md](VAST_ON_DEMAND_BETRIEB_2026-11-12.md).
Frühere Buchungen und Cleanup-Meldungen belegen keinen heutigen Accountbestand.
