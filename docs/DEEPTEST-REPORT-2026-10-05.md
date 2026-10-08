# DEEPTEST-REPORT 2026-10-05

**Lauf:** 2026-10-04 22:16 – 2026-10-05 02:26 (4,17 h) · **Deploy-SHA:** `7390f23`
**Ziel:** `https://anunnakitools.de` (frisch provisionierte Hetzner-Flotte, 5 Rollen)
**Kosten:** ~0,16 EUR brutto (5 × cx23 für 4,17 h) · Flotte gestoppt, 0 Server aktiv
**Plan:** docs/DEEP-TEST-PLAN.md (T0–T5)

---

## Ergebnis

| Phase | Status |
|---|---|
| T0 Preflight | ✅ Token/PREFLIGHT/Zertifikate geprueft, DNS-Drift gefunden |
| T1 Test-Infra | ✅ war bereits repariert (tests/e2e/package.json, Playwright 1.62.1) |
| T2 Flotte + Deploy | ✅ 5 Knoten provisioniert, app-1 healthy, Domain verdrahtet |
| T3 Infra-Tiefe | ✅ Monitoring (prometheus/grafana/alertmanager/cadvisor/node-exporter) + coturn + Stem-AI aktiv |
| T4 Browser-Tests | ✅ **50 passed / 5 failed / 5 skipped** |
| T5 Bericht + Abbau | ✅ Flotte gestoppt, 5 Snapshots angelegt, Retention 10 behalten |

## E2E-Ergebnisse (13 Specs gegen die echte Domain)

**Gruen (33 Tests + 17 aus der ersten Runde = 50):**
smoke, startState, masterPlayerFixed, audioAction, a11y (inkl. prefers-reduced-motion!),
visual, pluginCloseSync, scratchpad, keyboard, responsive, hardware, collab (7),
monitorCue, performance (CPU 19,3 % unter Last), audio-smoke, v2-live

**Rot (5 Tests):**
- `aiNegative.spec.ts` 4× — AI_MODE nicht auf dem Knoten gesetzt (Vision-Routen liefern 400
  statt 503 AI_DISABLED). **Kein Sicherheitsproblem**: ohne Token antworten alle AI-Routen
  korrekt 401 (Studio-Gate fail-closed, live gemessen).
- `live2browser.spec.ts` 1× — Peer-Verbindung kam nicht zustande; SFU/TURN-Kette war zum
  Testzeitpunkt noch unvollstaendig (coturn erst danach gestartet, DNS zeigte noch auf alte IP).

## Was der Lauf ueber die Infrastruktur gezeigt hat

Der Flottenstart (`bring-up-fleet.sh`) ist **nicht selbsttragend** für die Nicht-App-Rollen.
Live gefunden und einzeln behoben (Details in INFRA-HETZNER-017):

1. Schritt 4/9 brach mit SSH-TIMEOUT ab (alter Host-Key nach Neuprovisionierung) —
   die folgenden Rollen-Schritte liefen dadurch nie.
2. sfu-1/master-1/edge-1 erhielten **kein Repo** nach `/opt/audiomonastry` (manueller rsync noetig).
3. Auf allen Nicht-App-Knoten fehlte die `.env`, die `env_file: .env` zwingend braucht.
4. Das Caddy-DNS-Image (`audiomonastry-caddy-dns:2.9`) wird nur auf app-1 gebaut, obwohl
   sfu-1 und edge-1 ebenfalls Caddy fuehren — musste dort manuell gebaut werden.
5. ai-1: `install-ai1.sh` muss vom Betreiber-Rechner laufen (`root@<ip>`), nicht auf dem Knoten.

Alle fuenf Punkte liessen sich manuell loesen; der Lauf war danach vollstaendig.

## Neue SSOT-Eintraege

| ID | Prio | Titel |
|---|---|---|
| LIVE-P1-004 | P1 | AI_MODE auf Hetzner-Knoten setzen |
| LIVE-P1-005 | P1 | live2browser: Peer-Verbindung scheitert (SFU/TURN-Kette) |
| INFRA-HETZNER-017 | P0 | bring-up-fleet.sh versorgt Nicht-App-Rollen unvollstaendig |
| INFRA-HETZNER-018 | P1 | cf-dns-ensure.py liest Token nicht aus .env.deploy |
| PROD-P1-011 | P1 | Cloudflare-Token mit Zone:DNS:Read statt Edit |

## Artefakte

- Reports: `test-results/e2e-hetzner/20261005-010859/` (T4) + `.../20261005-021903-rest/` (T4b)
- Lauf-Logs: `~/.hermes/cache/scratch/deeptest-T*.log`
- Snapshots: `audiomonastry-{app,sfu,ai,master,edge}-1-auto-20261005-0026`

## Definition of Done (aus dem Plan)

- [x] T0–T5 durchgelaufen, Report im Repo
- [x] Nicht-`@ai`-Specs gruen gegen die Hetzner-Instanz
- [ ] Negativ-Suite AI strikt off belegt — **AI_MODE fehlt auf dem Knoten** (LIVE-P1-004)
- [x] Flotte gestoppt (Kosten 0), Snapshots intakt
- [x] SSOT aktualisiert (5 neue Eintraege)
