# NEXT_SESSION: Uebergabe (Stand 2026-10-13 11:10 UTC)

Fuenf Agenten-Arbeiten laufen/liefen; Zwischenstaende liegen als `wip/*` auf origin (NICHT auf main):

| Branch | Ticket/Inhalt |
|---|---|
| `wip/feat-fleet-p1-002-005-ears-handlers` | FLEET-P1-002..005 (handlers_ears.py) |
| `wip/feat-fleet-p1-006-stem-rp5-wiring` | Stem-Modell pruefen, stemMONK ueber RP5, Gewichte-Spiegel (FLEET-P1-006/-013) |
| `wip/feat-acestep-model-rule-drop-lego` | sft/base-Regel, Drop voll anbinden, LEGO im aiMONK |
| `wip/worktree-agent-a41c91228c5442d6f` | Auto-Stop + Snapshot + 0 EUR/h (FLEET-P1-012) |
| `wip/feat-fleet-p1-007-010-rp4-voice-handlers` | FLEET-P1-007..010 (handlers_voice.py) |

Vorgehen: je Branch `git merge origin/wip/<name>`; Konflikte in MASTERTODOENDE.json/FINALEAUFGABEN.json ticketweise loesen (Branch-Version der geaenderten Tickets uebernehmen); dann `npx tsc --noEmit`, `NODE_ENV=test npx vitest run` (bekannt rot: moaBoundary, namingConventions x2, portalWorkerFirewallMetrics), `node scripts/validate-interface-boundaries.mjs`, `python3 -m unittest discover -s services/audiomonastry-ai-runtime/tests`; pushen auf main. Unfertige Branches vorher auf Vollstaendigkeit pruefen (Agent kann abgebrochen sein).

Offene Entscheidung/Hinweise: siehe docs/AI_FLEET_STARTPLAN.md (Offen-Abschnitt), Tickets FLEET-P1-0xx.
