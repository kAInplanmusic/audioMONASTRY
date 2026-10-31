# Audit-Arbeitsstand – WIP

Dieser Branch sichert den unvollständigen lokalen Arbeitsstand. Er ist **keine Merge- oder Deploymentfreigabe**.

- Basis: Commit `3e351f775e28edfe7192121fc3d88f59971fa300`.
- SFU-Autorisierung und Mitgliedschafts-Widerruf: Regressionen ergeben unter Node 22 sieben Fehler und zwei bestandene Tests (Socket-Tests mit gemocktem Mediasoup-Worker).
- Checkpoint und Fleet-Autostop, Migration älterer lokaler Daten, Rate Limits, Docker-Konfiguration und Live-Timing benötigen weitere Arbeit und Prüfung.
- Audio-Regressionsläufe unter Node 22: 12/12 Tests für Worklet-Quellenkollision und Source-Contention sowie 30/30 für Sink Engine, Named Notes und Selective Release bestanden. Das ersetzt keine Browser- oder Hardware-Audio-Prüfung.
- Die vollständige `npm run verify`-Suite und tatsächliche Docker-Images sind nicht erfolgreich vollständig validiert. Ein unabhängiger Review meldete Release-Blocker.
- Diesen Stand vor Merge und Einsatz vollständig prüfen; Rückschlüsse auf Produktionsreife sind unzulässig.
