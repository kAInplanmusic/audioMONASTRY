# R19 Phase 3 - Final Status Report

## Problem Statement

SSH-Zugriff auf Hetzner-Cloud-Server ist blockiert durch:
1. **Ubuntu 22.04**: "Password change required but no TTY available"
2. **CentOS 9**: Gleiche Fehlerbasis

Dies ist ein Standard-Sicherheitsfeature vieler Cloud-Images nicht umgangen ohne Interactive TTY.

## Versuchte Lösungen

| Methode | Ergebnis |
|---------|----------|
| cloud-init mit SSH-key | Key wird akzeptiert, aber Login blockiert |
| Ubuntu + hallerbans-key | `Permission denied (publickey,password)` |
| CentOS + wan-test-key | `Password change required but no TTY available` |
| hcloud console | API endpoint nicht verfügbar |

## Architektur-Änderung

### Original geplant (4 separate Server)
```
[nbg1] Producer  ---\
[hel1] Mastering   }---> CCX33 Main (PA/DJ)
[ash] AI         ----/
[fsn1] DJ-Cue ----/
```

### Überarbeitet (lokale Simulation)
```
Main Server: 167.233.221.141 (CPX32, fsn1)
    |
    +---> localhost:3001 (producer)   → tc delay 30ms
    +---> localhost:3002 (mastering)  → tc delay 80ms loss 1%
    +---> localhost:3003 (ai)         → tc delay 150ms loss 0.5%
    +---> localhost:3000 (dj-cue)     → no throttling
```

## Network Latency Profiles

| Bot | RTT | Packet Loss | Simulated Location |
|-----|-----|-------------|-------------------|
| producer | 30ms | 0% | Stadtnetz |
| mastering | 80ms | 1% | Schul-WLAN |
| ai | 150ms | 0.5% | Ferner Standort |
| dj-cue | 0ms | 0% | Lokal |

## SSH Key Credentials

- **Key Name**: wan-test-key
- **Key ID**: 132692929
- **Public Key**: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJzWJYR55s8YLRvIcO7fjM7dJZDYuOVlB9+3wJcqfQ0x wan-test-bot`

## Nächste Schritte

1. ☐ Bestätigen: Docker-basierte Simulation starten
2. ☐ CCX33 auf `/opt/am-r16-impl/` deployed
3. ☐ 60s Test mit tc netem durchführen
4. ☐ Ergebnisse messen (CPU, Dropouts, Waveform)
5. ☐ Aufräumen

## Warum CCX33 nicht gelöscht werden muss

CCX33 ist ein bestehender Testhost (nicht vom WAN-Test erstellt). Er bleibt bestehen.

---

**Status**: Warte auf Bestätigung für lokale Docker-Simulation