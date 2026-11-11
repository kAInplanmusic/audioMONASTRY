# audioMONASTRY Deployment Issues & Action Items

## Issues Found (2026-11-07)

### Issue 1: SSL/TLS Certificate Problem
- **Beschreibung**: Caddy-Weiterleitung von HTTP zu HTTPS schlägt mit `TLSV1_ALERT_INTERNAL_ERROR` fehl
- **Auswirkung**: HTTPS-Aufrufe mit eigenem Cert-Check schlagen fehl
- **Workaround**: DNS-Hosteintrag für `anunnakitools.de:443` auf 78.47.218.180 auflösen (`curl --resolve`)
- **Status**: ❌ Offen
- **Priorität**: Hoch
- **Ticket-Nummer**: DEPLOY-001

### Issue 2: STUDIO_TOKEN fehlt für API-Endpunkte
- **Beschreibung**: `/api/brain/chat` und `/api/models` erfordern STUDIO_TOKEN
- **Auswirkung**: KI-Modelle nicht über API aufrufbar ohne Auth
- **Ursache**: STUDIO_TOKEN nicht in `.env.deploy` definiert
- **Status**: ❌ Offen
- **Priorität**: Mittel
- **Ticket-Nummer**: DEPLOY-002

### Issue 3: RunPod A40-Kapazität ausgebucht
- **Beschreibung**: NVIDIA A40 (48GB) nicht verfügbar, keine alternativen GPUs in Konfiguration
- **Auswirkung**: brain/ears/voice/music Pods können nicht gestartet werden
- **Lösung**: RTX PRO 5000 Blackwell / RTX PRO 6000 MIG hinzugefügt
- **Status**: ✅ Gelöst
- **Ticket-Nummer**: DEPLOY-003

### Issue 4: Budget-Überschreitung
- **Beschreibung**: Ursprüngliches Budget 4€/h wurde überschritten (4.60€/h)
- **Auswirkung**: Pod-Start würde abgelehnt
- **Lösung**: Budget auf 6€/h erhöht, stems auf 24GB-Pool umgestellt
- **Status**: ✅ Gelöst
- **Ticket-Nummer**: DEPLOY-004

## Aktionsplan

1. [ ] DEPLOY-001: SSL-Zertifikat auf Caddy prüfen/erneuern
2. [ ] DEPLOY-002: STUDIO_TOKEN in .env.deploy eintragen
3. [ ] DEPLOY-003: RunPod-Pods starten (Kapazität prüfen)
4. [ ] DEPLOY-004: Monitoring für Kosten einrichten

## Technische Details

### Verfügbare GPUs (unter $1/h)
48GB:
- NVIDIA RTX PRO 5000 Blackwell: $0.82/h
- NVIDIA RTX PRO 6000 MIG 2g.48gb: $1.00/h

24GB:
- NVIDIA RTX 4090: $0.34/h
- NVIDIA RTX PRO 6000 MIG 1g.24gb: $0.50/h (Medium stock)

### Konfigurierte Preise
Siehe `deploy/gpu/pod-fleet.json`

## Änderungen durchgeführt

1. `deploy/gpu/pod-fleet.json`:
   - `maxEurPerHour`: 4 → 6
   - 48GB GPUs aktualisiert (A40 aus, RTX PRO 5000/6000 eingetragen)
   - stems-Pod auf 24GB-Pool umgestellt

2. `scripts/runpod-pods.py`:
   - `ALLOWED_GPU_IDS` um RTX PRO 5000/6000 erweitert

3. Dokumentation erstellt:
   - `docs/RUNPOD_DEPLOY_COMPLETE.md`
   - `docs/RUNPOD_ISSUES.md` (diese Datei)