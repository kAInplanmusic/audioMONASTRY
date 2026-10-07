# PLAN 2026-10-07 — Pluginpool auf v2, 4-Server-Strategie, Deploy

Betreiber-Auftrag: Pluginpool vollstaendig definieren + verdrahten (wie Ableton),
auf v2 zum Laufen bringen, 4-Server-Strategie inkl. neuester Builds deployen,
testen, loggen, Snapshot. Plugins sind **1x haltbar** (nie von mehreren Nutzern);
Halter = erster bzw. am laengsten angemeldeter User. Optional Anmeldescreen.
Provider-Wahl: **CometAPI** (freigegeben bis 5 USD).

## 0. Ausgangslage (verifiziert, nicht behauptet)

| Fakt | Beleg |
|---|---|
| `origin/main` = `8fd62b2` (mein Reset-Fix committet+gepusht) | `git log` |
| `origin/visuals` + `origin/claude/new-session-yw6ct7` sind **schon in main** | `git log main..branch` = leer |
| Pluginpool: **16 Plugins** in 4 Kategorien + 3 System-Module | `src/plugins/registry.ts` |
| Signalweg: sources(9) → mixer → processing(5) → record → out | `src/plugins/signalChain.ts` |
| **18 Adapter** existieren (1 pro Plugin + Biblio), aber **keiner** hat `processBlock` | `grep -c processBlock adapters/*` = 0 |
| Echte Audio-Kette liegt in `src/core/audio/` (V2StudioGraph, AudioGraph, WorkletGraphRuntime) | Verzeichnis |
| Mixer-Regel: immer ON, genau 1 Halter, nur Uebergabe | `UI2-P0-001`, `pluginMode.ts:48-49` |

**Der Kern-Befund:** Adapter sind Zustandstraeger, die Audio-Verarbeitung liegt in
`src/core/audio/`. „Verdrahtet wie Ableton" heisst also: **jedes der 16 Plugins
muss einen echten Knoten in der v2-Kette haben** — nicht nur einen Adapter.

## 1. Der offene Blocker (zuerst, weil alles daran haengt)

**Mixer-Deadlock:** `nextModeStep('mixer',...)` liefert IMMER `denied`
(`pluginMode.ts:48`), der Modus-Button ist IMMER disabled (`App.tsx:896`). Der
Server vergibt den Halter nur beim Socket-Beitritt. Faellt die Socket-Verbindung
aus, ist der Mixer **unbedienbar** — niemand kann ihn holen.

Zusaetzlich: Im Playwright-Lauf kommt **kein einziger Socket-Beitritt** an
(`grep -c peer-joined` = 0), obwohl die Route direkt `200` liefert.

**Betreiber-Regel dazu (2026-10-07):** Plugins sind **1x haltbar**. Halter =
erster User oder der am laengsten angemeldete. Genau das setzt `ensureHolder`
bereits um (`members[0]`) — es muss nur **immer** greifen, auch ohne
Socket-Beitritt.

**Loesung (2 Teile, ohne Regelbruch):**
1. Server: Halter-Vergabe **idempotent** bei jedem relevanten Ereignis
   (Beitritt, Reset, Lock-Ablauf, Reconnect) — nicht nur beim ersten Join.
2. Client: Meldet der Server keinen Halter, **fordert der Client ihn an**
   (statt dauerhaft disabled). Das ist keine Aufweichung von „1x haltbar",
   sondern die fehlende Anforderung im herrenlosen Fall.

## 2. Provider-Entscheidung: CometAPI

- Einziger der drei mit hinterlegtem Key (`COMETAPI_KEY`, `~/.hermes/.env`).
- **550 Modelle**, davon ~150 starke. Verifiziert per `GET /v1/models` (200).
- Getestet und antwortbereit: `claude-opus-5` (9,5 s), `claude-opus-4-8`,
  `claude-sonnet-5`, `deepseek-v4-pro` (3,2 s), `gpt-5`, `gpt-5.6`.
- Hinweis: `COMETAPI_API_KEY` ist **verunreinigt** (Kommentar in der Zeile) —
  `COMETAPI_KEY` benutzen.

**Rollenverteilung (Budget bis 5 USD):**

| Zweck | Modell | Warum |
|---|---|---|
| Architektur/Audit (Planung, Review) | `claude-opus-5` | staerkstes verfuegbares Reasoning |
| Massenarbeit (Adapter-Verdrahtung) | `deepseek-v4-pro` | 3,2 s, guenstig, Code-stark |
| Gegenpruefung | `gpt-5.6` | unabhaengige zweite Meinung |

Budget-Disziplin: max. ~1,50 USD pro Phase, Rest als Reserve. Jeder Aufruf wird
mit Token-Zahlen geloggt (die API liefert `usage`).

## 3. Phasenplan

### Phase A — Blocker loesen (kein KI-Budget)
- A1: Halter-Vergabe idempotent machen + Client-Anforderung im herrenlosen Fall.
- A2: Socket-Verbindung im Playwright-Lauf klären (warum 0 Beitritte).
- A3: `UI2-P1-001` belegbar machen (visueller Lauf gruen, Baselines neu).
- Gate: `npm run verify` EXIT=0 + visueller Lauf EXIT=0.

### Phase B — Pluginpool definieren (eine Quelle)
- B1: **Ein** Register als Wahrheit: `plugins/registry.ts` (16) +
  `signalChain.ts` (Reihenfolge) + `pluginChannelMap.ts` (8 Kanaele)
  zusammenfuehren zu **einer** deklarativen Tabelle.
- B2: Pro Plugin deklarieren: id, Name, Kategorie, Kanal, Knotentyp,
  Parameter-Vertrag, Latenz, SYNC-Faehigkeit, Halter-Regel.
- B3: Test, der Registry, Signalweg, Kanaele und Adapter gegeneinander prueft
  („eine Regel, eine Stelle").

### Phase C — Verdrahtung wie Ableton (das Kernstueck)
Zielbild: Jedes Plugin ist ein **Knoten in der v2-Kette** mit
`parameter`-Vertrag, Bypass, Latenz-Ausgleich (PDC) und serieller/paralleler
Verschaltung — genau wie ein Ableton-Device.
- C1: Knoten-Interface je Kategorie (source / insert / bus / master / recorder).
- C2: 9 Quellen als `SourceNode`-Traeger an die 8 Kanaele binden.
- C3: processing-Kette serial: effect → eq → dsp → spatial (mit Bypass + PDC).
- C4: master + record als Abschluss; FX-Bus als parallele Ebene (Send/Return).
- C5: Pro Plugin ein Hoer-/Signalnachweis (Test, nicht Behauptung).

### Phase D — 4-Server-Strategie deployen
Die „4 Server" sind aus dem Repo zu belegen (Hetzner-Flotte + RunPod-Rollen).
- D1: Zielbild aus `scripts/hetzner/` + `docs/` herausarbeiten (4 Knoten:
  welche Rollen, welche Groessen, welche Ports).
- D2: Neueste Builds erzeugen (Client + Server + Runtime-Image).
- D3: Deployen, Logs einsammeln, E2E gegen die echte Instanz fahren.
- D4: Snapshot (Zustand sichern, Wiederaufsetzpunkt dokumentieren).

## 4. Was ich von dir brauche

1. **Keys**: `RP_AGENT_KEY` (RunPod) und ggf. `HETZNER_API_TOKEN` — ohne die ist
   Phase D nicht fahrbar (beides fehlt aktuell).
2. **Anmeldescreen**: Name + E-Mail + Benutzername vor dem Verbinden — einbauen
   oder nicht? (Deine Aussage: „gerne ... wenn das hilft".)
3. **4-Server-Strategie**: Bestaetige, ob die 4 Knoten aus Phase D1 gemeint sind
   (Hetzner-Flotte) oder ob es eine eigene Aufteilung ist.

## 5. Arbeitsweise

- KI nur fuer Architektur/Review, nicht fuer Massenaenderungen mit Nebenwirkung.
- Subagenten (bgworker) fuer klar abgegrenzte, pruefbare Pakete.
- **Jede Behauptung wird am Code/Test nachgeprueft** — auch die der Subagenten.
- SSOT (`MASTERTODOENDE.json`) nach jeder Phase aktualisieren, per Skript.


---

## 6. NACHBESSERUNG nach Architektur-Review (CometAPI / gpt-5.6, 2026-10-07)

Die Reihenfolge A→B→C→D ist grob richtig, **innerhalb der Phasen aber zu breit**.
Fuenf Korrekturen sind eingearbeitet:

### 6.1 Der Audiovertrag kommt VOR die Verdrahtung (neue Phase B0)
Ohne Vertrag wird jede Verdrahtung geraten. Je Plugin muss deklariert sein:
- **Kanalformat:** mono/stereo, erlaubte Up-/Downmix-Regeln.
- **Ein-/Ausgaenge:** Anzahl, Sidechain, Send/Return, Recorder-Tap.
- **Blockgroesse/Samplerate:** Verhalten bei Wechsel.
- **Parameter:** Einheit, Bereich, Default, **Glaettung**, Rate (`a-rate`/`k-rate`).
- **Tail-Time** (Reverb/Delay) und Verhalten bei Stop/Bypass.

### 6.2 PDC ist zu spezifizieren, nicht zu nennen
- `intrinsicLatencyFrames` je Plugin.
- Pfadlatenz = Summe der aktiven UND der bypass-ten Knoten.
- Kompensation **unmittelbar vor jedem Merge**.
- Rebuild bei dynamischer Latenzaenderung **an einer Blockgrenze**.
- Obergrenze und definiertes Verhalten bei nicht kompensierbarer Latenz.

### 6.3 Bypass ist nicht Disconnect
Kein Reconnect beim Umschalten: **latenztreuer Dry/Wet-Crossfade im Knoten**,
klickfrei, optional mit Tail-Erhalt. Sonst reisst jede Bypass-Schaltung die
Phasenlage und das PDC-Modell.

### 6.4 Zwei Regeln trennen, die der Plan vermischt hat
- **1x haltbar** = Besitz-/UI-Steuerrecht (serverautoritativ, Lease/Heartbeat).
- **1x instanziiert** = AudioNode-Lebenszyklus (einmal im DSP-Graph).
Das sind verschiedene Zustaende mit verschiedenen Lebensdauern.

**Wichtig:** „1x haltbar" braucht eine **stabile serverseitige Session-ID** —
nicht Name/E-Mail. Der Anmeldescreen ist damit nicht die Voraussetzung; die
stabile Identitaet ist es. Ein Anmeldescreen waere reine UX, kein Fix.

### 6.5 Topologie widerspruchsfrei machen
`effect`/`spatial` bilden den **parallelen FX-Bus (Return)**, `eq`/`dsp`/`master`
sind **serielle Master-Inserts**. Ein Plugin darf nicht beides sein. Diese
Zuordnung muss **vor Phase C** in der Registry festgeschrieben werden.

### 6.6 Korrigierte Reihenfolge
1. **A0** Protokoll-/Socket-Test VOR jedem Fix: mit zwei stabilen Sessions
   `join → erster Halter → zweiter wartet → Disconnect/Reconnect →
   deterministische Uebergabe` beweisen.
2. **A1** Identitaet + Ownership serverautoritativ, idempotent, mit Revision.
3. **B0** Audio-/Topologievertrag (6.1–6.5).
4. **B1** Deklarative SSOT (eine Tabelle, abgeleitete Maps).
5. **C0** **Vertikaler Spike**: EIN Pfad Quelle → Kanal → Insert → FX-Send/Return
   → Master → Recorder → Out, inkl. Bypass- und PDC-Nachweis.
6. **C1** Erst nach bestandenem Spike auf alle 16 erweitern.
7. **D0** parallel frueh auditieren (Rollen/Secrets), Deploy erst nach C-Gates.

**Nicht alle 16 Knoten gleichzeitig bauen.** Erst muss ein vollstaendiger Pfad
die Echtzeit-, Bypass- und PDC-Anforderungen beweisen.

### 6.7 Das eine Ding zuerst
Ein automatisieter Protokolltest mit **zwei stabilen Sessions**, der
`join → erster Holder → zweiter wartet → Disconnect/Reconnect → Uebergabe`
beweist. Erst danach Client-Fallback — sonst kaschiert zusaetzliche
Anforderungslogik einen ungeklaerten Socket-/Identitaetsfehler und erzeugt
Race Conditions statt einer belastbaren Halter-Regel.
