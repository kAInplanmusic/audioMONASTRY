# Kaltstart-Messprotokoll der Vast-Flotte

Dieses Log nimmt tatsächliche Messläufe aus dem Fleet-Runbook auf. Der
[vorhandene Messbericht vom 18. November](FLEET_INTERFACES_AND_GATES.md)
ist die historische Referenz. Neue Messungen ergänzen eine eigene Zeile je
Rolle mit Image-/Modellrevision, Ready-Zeit, Kosten und Teardown-Nachweis.

Einen bereits erfassten Lauf über sein lokales JSON eintragen:

```bash
python3 scripts/cold-start-report.py <state-dir>/cold-start-report.json
```

Betrieb und Freigabegates stehen im [Fleet-Runbook](FLEET_RUNBOOK.md).
