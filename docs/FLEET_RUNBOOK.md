# audioMONASTRY — Fleet Operations (SSOT 2026-11-10)

Die aktive Architektur ist **Hetzner-App-/RTC-Infrastruktur plus acht heterogene RunPod-Pods**. **Nicht** das historische Fünf-Pod-/A40-only-System.

Autorisierte Quellen:
- [RunPod SSOT](RUNPOD_FLEET_SSOT.md)
- [RunPod Operations](RUNPOD_PODS_RUNBOOK.md)
- `deploy/runpod/pod-fleet.json` (8 Rollen, GPU, Budget)
- `services/audiomonastry-ai-runtime/model_manifest.json` (Gewichte, Pins und Tasks)

## Vor jeglichem Start (nur Read-only)

```bash
python3 scripts/runpod-ssot-preflight.py --json
python3 scripts/runpod-pods.py plan
python3 scripts/runpod-pods.py weights
python3 scripts/runpod-pods.py status --json
```

`weights` liest R2 und benötigt authentifizierten Zugriff. Bei fehlender Authentifizierung oder abweichenden Pins ist das Gate **nicht bestanden**. Budgetlimit für die **gesamte RunPod-GPU-Flotte: 8 EUR/h**, einschließlich des konfigurierten Zuschlags und Puffers.

## Hetzner

Hetzner-Rollen sind getrennt von RunPod zu betrachten. Historische `scripts/hetzner/fleet-start-complete.sh`/`fleet-stop-complete.sh` gelten **nicht automatisch** als sichere Starter/Stopper für die aktuelle GPU-Flotte. Vor Verwendung müssen alle enthaltenen RunPod-Aufrufe auf die neue SSOT geprüft werden. Keine pauschalen Server-/Pod-Löschungen auf Produktionsdaten.

## Einzelner Live-Test

Ein einzelner Test-Pod muss vor Erstellung eindeutig als neu identifiziert sein und nach dem Test **tatsächlich gelöscht und per Provider-Inventar bestätigt** werden. Dafür existiert `scripts/runpod-live-verify.py`. Die Löschlogik im Prozess allein garantiert kein Cleanup bei SIGKILL, Netzwerkausfall oder Runner-Abbruch; zusätzlicher externer Watchdog und Kostenkontrolle erforderlich.

**WICHTIG: Ein existierender oder gestoppter Pod ist nicht automatisch kostenlos.** Abrechnung für Compute, Volumes, Storage und Snapshots unterscheiden. Weder `down --yes` (löscht gesamte benannte Flotte) noch historische Deploy-Skripte zur isolierten Verifikation verwenden.

## Secrets und Status

Secrets nur im dafür vorgesehenen Secret-Manager oder in lokal ignorierten Umgebungsdateien; nie in GitHub-Quelltext, Ausgaben oder Logs. Freigabestatus nur mit echten Nachweisen; statische Manifesttests belegen keine reale GPU-Kompatibilität.
