# PLAN & ZIEL — Signalkette fertig machen (C → A → B)

**Ziel (verbindlich, vom Betreiber gesetzt 2026-10-05):**
Die audioMONASTRY-Signalkette wird **vollständig fertig**: ausführbar, geordnet,
hörbar, im Live-Pfad verdrahtet. Abarbeitung **stückweise**, jeder Schritt mit
eigenem Commit, Test und Gate — bis alles durch ist, ohne weitere Rückfragen.

**Reihenfolge (Betreiber-Entscheidung):** erst **C kurz**, dann **A**, dann **B**.

**Arbeitsregeln:** erst messen, dann behaupten · jeder Schritt einzeln
committet und gepusht · Gate vor jedem Commit (`tsc` 0, `eslint` 0,
Boundary-Scan sauber, volle Vitest-Suite grün) · nichts blind umbauen, was nur
hörbar prüfbar ist · Befunde ehrlich in `docs/AUDIT-RESTTODOS.md`.

---

## Warum diese Datei existiert

Damit **nichts verloren geht**, wenn ein Lauf abbricht (Zeitlimit, Absturz,
Rate-Limit, Verbindungsverlust). Jeder Schritt ist hier mit seinem Zustand,
seinem Commit und dem Wiederaufsetzpunkt beschrieben. Neuer Agent, neue Sitzung:
**hier weiterlesen, nicht neu anfangen.**

---

## Stand (bei jedem Schritt aktualisieren)

| Phase | Inhalt | Status |
|---|---|---|
| Vorarbeit | Kette als Quelle, Router-Anker, Offline-Ausführer, Bounce im Recorder | **fertig** (`6bc5aac`) |
| **C** | Flotte kurz hoch, Deploy prüfen, wieder löschen | **offen** |
| **A** | Block-Verarbeitung in den Adaptern (15 von 16 fehlen) | **offen** |
| **B** | Live-Pfad auf die Kette umziehen (hinter Flag) | **offen** |

---

## Phase C — Flotte kurz, Deploy prüfen, Kosten stoppen

**Zweck:** Beweisen, dass der Deploy-Pfad mit dem aktuellen Code läuft
(inklusive Autoload, Transport, Signalkette) und dass die Flotte sauber hoch- und
wieder wegkommt. **Dauer:** kurz — bei Stillstand abbrechen, nicht stundenlang
nachbohren.

**Voraussetzungen geprüft:** Hetzner-Konto enthält aktuell **0 Server, 0 Volumes,
0 Snapshots, 0 Floating-IPs** → es gibt keine Altlast, die mitkostet.

**Schritte**
1. Bestand messen (`/v1/servers`) — muss 0 sein.
2. Flotte hochziehen mit den Typen des 3-Knoten-Profils
   (`docs/INFRA_KONSTITUTION.md` §3.1): app `cpx41`, sfu `cpx31`, master/edge
   `cx23`; weitere Rollen über `FLEET_TYPE_*`.
3. Deployen, dann messen: `/api/health` = 200 mit passendem Commit, TLS-Kette
   ok, `/api/metrics` mit `x-scrape-token` erreichbar, App liefert aus.
4. Prüfen, dass der gebaute Stand den Bounce-Code enthält.
5. **Abbrechen und löschen**, sobald messbar fertig oder Zeitbox abgelaufen.
   Kosten-Cap: ~0,12 €/h; Ziel: unter 1 h.

**Abbruchkriterium:** Wenn nach der Zeitbox kein `/api/health` 200 kommt →
Flotte löschen, Befund dokumentieren, weiter mit Phase A. Kein Nachbohren
(genau das hat letzte Sitzung Stunden gekostet).

**Kostenstopp-Beweis:** Nach dem Löschen erneut `/v1/servers|volumes|snapshots`
messen — muss wieder 0 sein.

**Wiederaufsetzpunkt:** Wenn hier abgebrochen: Flotten-Bestand messen; sind
Server übrig, zuerst löschen (`scripts/hetzner/lifecycle.sh stop --yes` bzw.
Hetzner-API), dann Phase A beginnen.

---

## Phase A — Block-Verarbeitung in den Adaptern

**Befund (gemessen):** Kein Adapter überschrieb `onProcess()` — die Kette war
geordnet, aber klanglich neutral. `master` (Master-Gain) ist der erste echte
Verarbeiter. 15 fehlen.

**Vorgehen: ein Adapter pro Schritt, je ein Commit**, in Kettenreihenfolge der
Nachbearbeitung zuerst (weil dort der Klang entsteht), dann Quellen, dann
Recorder.

| # | Adapter | Aufgabe im Block | Status |
|---|---|---|---|
| A0 | `master` | Master-Gain (Vorgabe 1.0, 0…2) | **fertig** |
| A1 | `effect` | Dry/Wet-Mix + Effekt-Gain | **offen** |
| A2 | `eq` | 3-Band (Low/Mid/High) als Shelves | **offen** |
| A3 | `dsp` | Filter (Cutoff/Resonanz), Low-/High-Pass | **offen** |
| A4 | `spatial` | Pan/Breite pro Kanal | **offen** |
| A5 | `record` | Block in den Aufnahmepuffer schreiben (Kettenende) | **offen** |
| A6 | `mixer` | Kanal-Gains/Pan als Summe | **offen** |
| A7 | `syntisampler` | Sample-Playback im Block | **offen** |
| A8 | `drumsampler` | Drum-Voice-Playback im Block | **offen** |
| A9 | `instru` | Instrument-Playback im Block | **offen** |
| A10 | `voice` | Voice-Block | **offen** |
| A11 | `sound` | Sound-Block | **offen** |
| A12 | `stem` | Stem-Trennung im Block | **offen** |
| A13 | `song`, `drop`, `biblio` | Katalog-/Auswahl-Rollen (kein Block-Audio) | **offen** |

**Regeln je Adapter**
- In-place, ohne Allokation (Adapter-Vertrag: `process()` ist echtzeit-sicher).
- OFF bleibt transparenter Bypass (Basisklasse garantiert das).
- Parameter ausschließlich aus `this.parameters` (gesetzt über `restore()`;
  `setParameter()` braucht einen Runtime-Kontext und ist im Bounce wirkungslos).
- **Keine zweite DSP-Wahrheit:** Wo die Engine schon rechnet (EQ/Effekt/Dynamik
  als Worklets), delegiert der Adapter oder spiegelt exakt dieselbe Formel.
- Test je Adapter: OFF = bit-gleich · Parameter wirkt · Grenzen geklemmt ·
  Reihenfolge im Bounce unverändert.
- Nach jedem Adapter: Gate laufen lassen, commit, push.

**Wiederaufsetzpunkt:** Nächste offene Zeile in der Tabelle. Commits tragen den
Adapter im Betreff (`feat(plugins): <adapter> Block-Verarbeitung`).

---

## Phase B — Live-Pfad auf die Kette umziehen

**Zweck:** Dieselbe Ordnung, die offline bewiesen ist, in den hörbaren Pfad
bringen — **hinter einem Flag**, Vorgabe AUS. Nichts ändert sich hörbar, bevor
es geprüft ist.

**Schritte**
1. Einhängepunkt bestimmen: dort, wo heute `monitorRoutingFacade` /
   `channelStripState` hängen — nicht daneben, sondern **daran**.
2. Tap einbauen: Block durch `PluginAudioPipeline` mit `SIGNAL_CHAIN_ORDER`,
   gesteuert über ein Flag (Settings, Vorgabe aus).
3. Flag aus → bit-gleiches Verhalten wie heute (Test beweist es).
4. Flag an → Kette wirkt; Test beweist die Reihenfolge live.
5. Messen: Latenz/CPU-Budget vor/nach (keine Regression).
6. Erst nach Gehörprobe des Betreibers: Flag umstellen.

**Risiko:** Das ist der einzige hörbare Pfad. Kein Umbau ohne Test, der die
Gleichheit bei Flag-aus beweist.

**Wiederaufsetzpunkt:** Flag-Name und Einhängepunkt stehen im Commit-Betreff
(`feat(engine): Live-Tap der Signalkette hinter <flag>`).

---

## Sicherheitsnetz (falls etwas schiefgeht)

- **Alles ist in Git.** Fluchtpunkt vor dieser Arbeit: `6bc5aac` (bzw. der letzte
  Commit mit grünem Gate). `git log --oneline` zeigt die Schritt-Historie.
- **Kein Schritt ohne grünes Gate.** Ein Commit mit rotem Gate wird nicht
  gepusht.
- **Kosten:** Flotte nur mit expliziter Freigabe; nach jedem Lauf Bestand messen.
  Löschen ist der einzige Kostenstopp — Stoppen kostet weiter.
- **Keine Secrets in Dateien/Commits:** `.env*` sind ignoriert; Tokens niemals im
  Klartext in Logs oder Commits.
- **Hörbares nie blind:** Alles, was nur hörbar prüfbar ist, wird hinter ein Flag
  gelegt oder offline bewiesen — niemals „wird schon passen“.
