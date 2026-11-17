# R19 Phase 2 - Bot Setup & WAN-Test Status

## Bot-Setup Ergebnis

### Erfolgreich erstellte Bots
| Name | ID | IP | Region | Status |
|------|-----|-----|--------|--------|
| wan-bot-producer | 176355206 | 2.31.146.30 | nbg1 | running |
| wan-bot-mastering | 176355249 | 167.235.141.170 | nbg1 | running |

### Probleme
1. **SSH-Zugriff gesperrt**: weder wan-test-key noch hallerbans-ed25519 funktionieren
2. **Primary IP Limit exceeded**: Konto hat begrenzte Anzahl an öffentlichen IPs
3. **Regionales Ressourcenengpass**: cx23, cx33, cpx21 nicht in fsn1/hel1/ash/verfügbar

### SSH Keys
- wan-test-key: ID=132692929 (neu erstellt)
- hallerbans-ed25519: ID=131941791 (alt)

## Alternative Test-Architektur

Da echte SSH-Zugriff nicht möglich ist, schlage ich vor:

### Option A: Web-basierte Tests
- Nutze `/master-out` Seite auf CCX33 (135.181.111.103)
- Browser-Automation via lokalem Terminal (Playwright)
- Network-Throttling simuliert verschiedene Regions-Latenz
- Misst: CPU, Waveform, Dropouts

### Option B: Bots als Container über Docker
- Deploye Container auf CCX33 selbst
- Jeder Container hat eigene "Region" via Netzwerk-Throttling
- Simuliert WAN-Verhalten ohne echte Remote-Bots

### Option C: Warten auf SSH-Berechtigung
- Bot-Admins konfigurieren SSH für wan-test-key
- Cloud-init abschließen
- Dann SSH-Zugriff herstellen

## Empfehlung
Option A: Web-basierte Tests mit Network-Throttling liefert ähnliche Ergebnisse
und ist sofort umsetzbar.

## Nächste Schritte
1. ☐ Bot-SSH-Problem lösen (Admin-Berechtigung)
2. Oder: Web-test mit lokalem Playwright starten
3. ☐ 60-Sekunden-Integrationstest durchführen
4. ☐ Ergebnisse dokumentieren
5. ☐ Bots löschen (falls erstellt)
6. ☐ SSH-Key löschen