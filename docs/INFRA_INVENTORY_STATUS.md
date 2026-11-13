# Verifizierter Infrastrukturstatus – A1, 2026-11-13

**GPU-Anzahl (aktueller Produktionsbestand): unbekannt.** Dies ist der zentrale
Statusort für den aktuellen GPU-Bestand; eine numerische Bestätigung fehlt.

Grundlage sind ausschließlich die ausgeführten A1-Prüfungen in
`EVIDENCE_REGISTRY.json`:

- `A1-access-preflight`: benannte Provider-Token fehlen; kein SSH-Verzeichnis.
- `A1-provider-hetzner`: Server-Liste blockiert, kein Provider-GET ausgeführt.
- `A1-provider-runpod`: Pod-/GPU-Liste blockiert, kein Provider-GET ausgeführt.
- `A1-docker-ps-local`: nur Container-Sicht der Cloud-Session; kein Beleg für
  Produktionshosts.

Hetzner-Produktionshosts, deren Container und aktive GPU-Ressourcen wurden somit
nicht inventarisiert. DNS-Auflösung bestätigt keine laufenden Container, Rollen
oder GPUs. Historische Zahlen, GPU-Zielpläne und ausführbare Flottenkonfigurationen
sind kein Ersatz für diese fehlenden Messungen.

Eine GPU-Zahl darf hier erst nach erfolgreicher lesender Provider-Abfrage mit
Befehl, Originalausgabe und Zeitpunkt eingetragen werden. Bis dahin bleibt die
numerische GPU-Single-Source-of-Truth-Anforderung aus A2 offen. Es wird weder ein
leerer Produktionsbestand noch eine laufende Sollflotte behauptet.
