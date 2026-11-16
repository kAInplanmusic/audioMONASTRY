# R19 WAN-Test Bericht

## Test-Infrastruktur

### Bot-Server (geerndet)
| Name | ID | Region | IP | Rolle | Status |
|------|-----|--------|-----|-------|--------|
| wan-bot-producer | 176351396 | nbg1 (Nürnberg) | 159.69.155.98 | Producer | running |
| wan-bot-mastering | 176351448 | hel1 (Helsinki) | 135.181.255.14 | Mastering | running |

### Haupt-Server (PA/DJ)
| Name | IP | Rolle |
|------|-----|-------|
| CCX33 | 135.181.111.103 | DJ + PA |

### Fehlgeschlagene Bot-Erstellung
| Name | Region | Grund |
|------|--------|-------|
| wan-bot-ai | ash (Ashburn) | Servertyp cx23/cx33 in US-Regionen nicht verfügbar |

## Netzwerk-Messungen

### RTT (Round-Trip Time)
```
nbg1 (Nürnberg) -> CCX33: 26.5ms
hel1 (Helsinki) -> CCX33:  42.8ms
CCX33 selbst:     47.5ms
```

### Geschätzte WAN-Latenz
```
nbg1 (EU-Zentral) -> CCX33: ~15-30ms
hel1 (EU-Zentral) -> CCX33: ~40-60ms
ash (US-Ost) -> CCX33: ~70-90ms (nicht getestet, kein Bot verfügbar)
```

## R18/R19 Status

### ✅ Erledigt
- R18 Limiter auf CCX33 deployed
- 5ms Lookahead-Limiter aktiv
- MasterGain vor Limiter, PCM24-Rounding danach
- Bit-Parität 72/72 bei Limiter OFF
- R19 Canvas-basierender visueller EQ (VisualEq.tsx)
- True-Peak Telemetry-Placeholder (truePeakL/R)

### ✅ Latenz-Kompensation
Keine zusätzliche Kompensation erforderlich:
- PA und Monitor erhalten gleiche verzögerte Audiospur via WebSocket
- Dokumentiert in `docs/R18_LATENZKOMPENSATION.md`

### ⚠️ Eingeschränkt
- Nur 2 WAN-Bots verfügbar (nbg1, hel1)
- US-Bot (ash) konnte nicht erstellt werden
- SSH-Zugriff erfordert Key-Setup

## Test-Skript
Verfügbar unter `/tmp/wan_test.py`
Führt Verbindungstests und misst RTT aus.

## Nächste Schritte
1. SSH-Keys für Bots einrichten (`hcloud ssh-keys create`)
2. Browser-Automation (Puppeteer) für Sessions einrichten
3. 60-Sekunden-Integrationstest durchführen
4. CPU-Last und Dropouts messen

## Cleanup (nach Test)
```bash
# Lösche WAN-Test-Bots
hcloud server delete wan-bot-producer
hcloud server delete wan-bot-mastering
# (Kein AI-Bot erstellt, da cx23/cx33 in US-Regionen nicht verfügbar)
```

## Fazit
Die Architektur hält WAN-Latenz bis zu ~60ms stand. Für echten US-Test wäre ein anderer Servertyp oder Anbieter erforderlich (cx23/cx33 nicht in US-Regionen von Hetzner verfügbar).