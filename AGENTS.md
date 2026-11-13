# 🚨 CRITICAL ARCHITECTURE & PROJECT RULES – READ BEFORE CODING 🚨

This document defines the absolute, unbreakable core principles of this application. Every agent, developer, and architect MUST read, understand, and adhere to these rules before writing a single line of code. Failure to comply will result in major architectural regression.

---

## 1. Core Architectural Pillars

### 1.1 The "Orchestra" Backend & "Main Sound"
* **The Orchestra:** The main backend acts strictly as an orchestrator. It manages state, routing, synchronization, and multi-user inputs.
* **The Main Sound:** The master audio engine lives within the core backend. It compiles, mixes, renders, and outputs the final audio signal.
* **Decoupled Plugins:** Everything else is a plugin. Plugins can be built as Docker containers, inline code modules, APIs, or HTTP services. The core backend does not care about the underlying tech stack of a plugin, only its standardized interface.

### 1.2 Frontend & Multi-User State Synchronization
* **The Screen:** The frontend is a unified "Stream Screen" component layout.
* **Up to 4 Users:** Up to four concurrent users can log into the exact same frontend session. 
* **Identical State Mirroring:** Every user sees a 100% identical, real-time copy of the main UI screen.
* **Concurrency & Locking (B2B / Busy Mode):** 
  * When a user interacts with or controls a specific plugin, that plugin immediately switches to **Locked Mode** (Visual feedback: grayed out / unalterable) for all other 3 users.
  * Other users can *only* toggle their local view of that plugin (Icon vs. Terminal View). They cannot alter its parameters while locked.
  * Plugins not controlled by a human must run either in **Off** mode or **Auto AI** mode.
  * This architecture must fully support remote collaboration with zero state desync.

### 1.3 The Live Mandate (Betreiber 2026-10-12)
* audioMONASTRY ist eine **Live-Audio-App**: mehrere Komponenten und bis zu 4 Nutzer arbeiten wirklich live und **möglichst latenzfrei**. Das ist die feste Vorgabe; eine einzelne Millisekunden-Zahl ist bewusst **nicht** Teil des Mandats.
* Jede Routing-Entscheidung, jedes Netzwerkpaket und jede Puffer-Berechnung wird so gebaut, dass sie keine vermeidbare Latenz erzeugt. Latenz, die sich nicht vermeiden lässt (Blockgröße, Gerät, Netz), wird gemessen, angezeigt und ausgeglichen (PDC) – nie versteckt.
* Das Mastering-Tool braucht eine eng kontrollierte, vorhersagbare, ultrakurze Verzögerung. Latenzaufbau über mehrere Plugins hinweg ist ein kritischer Fehler.
* Messbare Grenzen liefert `npm run audit:rt` (CI-Gate) – dort stehen die geprüften Budgets, nicht hier.

---

## 2. UI/UX & Plugin Interface Conventions

### 2.1 Top Navigation Bar
* Head (operator 2026-10-07): logo · the 16 plugin icons in two rows of 8 · user display with the menu/settings button attached · a Visuals on/off switch (mixer holder only). No stream or scratchpad button in the head (Main is always on; the rest lives in the menu).
* Fixed parts (not closable, not movable, not sticky): mastergraphMONK at the top; aiMONK and perforMONK at the bottom after the rack. In between: mixerMONK and the 15 plugins as collapsible rack modules (collapsed: name, holder, Aus/An/KI, SYNC, mini meter, ▶/■, fold arrow).
* Each icon has a distinct color scheme. This color code dynamically dictates the entire visual design, borders, and theme of that specific plugin's window when opened.

### 2.2 The "Terminal Plugin" Concept
Operator correction 2026-11-13: aiMONK is a fixed, always-open bottom module for every user. It has no OFF/ON/PRO/AI mode selector and no close/collapse control; it is not one of the 16 canonical audio plugins. Existing task execution still observes server-side permissions. Betreiberpräzisierung 2026-11-13: nur ein gemeinsames Text-Eingabefeld, Ausführung ausdrücklich abgesendeter Anforderungen; kein periodischer aiMONK-Hintergrundlauf, keine Transport-/Agent-Schalter (KI-Freeze-Ausnahme zum aiMONK-Zugriff und zur Entfernung des unverdrahteten Legacy-AUTO_AI-Pfads; Beleg `R3-T0A-OPERATOR-CLARIFICATION`, Diff gegen `2f813a0`).

Each regular plugin has exactly three operating choices (spec: `docs/UI_SPEC.md`):
1. **Aus:** inactive, transparent bypass (`OFF`). The rack action saves settings and releases the lock.
2. **An:** manually active (`PRO` internally), controlled by its holder.
3. **KI-gesteuert:** existing per-plugin automation (`AUTO_AI` internally). The holder authorizes a server-attested, expiring generation, then releases the human lock. A new human holder revokes AI authority.
* The choices are independent of lock acquisition. A new activation waits for the server's ownership confirmation. There is no visible STBY mode.
* Foreign plugins remain locked: no request, no takeover. `mixerMONK` remains always ON with exactly one server-enforced holder, who alone may hand it over; this Main-output invariant is unchanged.
* A holder may fold their own plugin view without stopping authorized AI control. The current settings and operating mode remain session state.
* Every plugin that plays or creates-and-plays audio has a **SYNC** button against Main (default on; `src/core/session/pluginSync.ts`).
* **Plugins are persistent:** the last settings of every plugin live in the server session (only the holder or a valid server-attested delegation writes; saved on every change and immediately on leaving). Whoever takes a plugin next starts with exactly that state (`src/core/session/pluginSettingsSync.ts`, `src/utils/pluginSettings.ts`). Plugin settings must never live only in local component state or browser storage.
* **Nothing on user devices – grundsätzlich:** no localStorage/sessionStorage/IndexedDB/OPFS, no audio or files on the device by default. Studio data lives in the session's server-side studio store (`src/utils/storage.ts`, `src/utils/studioStoreSync.ts`); only `MEMORY_ONLY_KEYS` stay in memory. Audio always goes to the server.
* **Ausnahmen (Betreiber 2026-10-12), nur ausdrücklich und per Nutzeraktion:** (1) eigene Presets, (2) Aufnahmen von recordMONK, (3) weitere sinnvolle Nutzerexporte (z. B. Projekt-Bundle). Sie werden als Datei-Export/-Import (Download bzw. File-System-Access mit Nutzerwahl) umgesetzt, **nie** als verdeckter Browser-Speicher, und die Quelle der Wahrheit bleibt der Server. Neue Ausnahmen brauchen einen Eintrag hier.
* **Main outputs:** exactly one device per main output — `/master-out` (audio) and `/visual-out` (visuals), reachable via internet or LAN. The first device holds the address; every further device is refused by the server.

---

### Runde 4 – Betreiberfreigabe mit technischer Sperre (2026-11-13)
Betreiberzitat: „205a43a (MoaAssistant zusätzlich für biblio/spatial/master) ist INHALTLICH GEWOLLT.“ Nachweis A: „205a43a aktiviert nur den KI-Modus für diese drei Plugins wie für die anderen 13; es startet keinen globalen Automatiklauf ohne Halterbezug.“ Die produktive Einbindung verlangt `ownedByMe && mode === 'AI'` (App.tsx:957); fünf zusätzliche Scope-/Identitäts-/Kein-Global-Timer-Tests und die bestehenden Fremdsperren belegen diesen Teil (`R4-P1-COMPILE-CLEAN-STOP`). Mixer bleibt die bestehende Immer-an-Ausnahme.

**STOP für die Ausführungsfreigabe:** Bedingung B scheitert in drei Tests mit dem echten gated Executor: Widerruf während `await confirmWrite` verhindert den nachfolgenden Dispatch nicht (`R4-P1-COMPILE-CLEAN-STOP`, MoaAgent.ts:392,403,409). Kein KI-Freeze-Gesamt-OK, kein Merge oder Einschalten aus dieser Produktfreigabe ableiten. Betreiber wurde informiert; keine Runtime-Reparatur unter Umgehung der STOP-Regel.

Neue Betreiber-Zielsemantik: „OFF und KI geben den Lock frei.“ Der Iststand oben beschreibt noch den behaltenen Lock und ist dafür **nicht umgesetzt**. Nötig ist getrennte serverattestierte KI-Delegation mit kanonischem Plugin, delegierendem Nutzer und widerrufbarer Generation; der freigegebene menschliche Lock darf keinen halterlosen globalen Lauf erzeugen. aiMONK bleibt separat, manuell auf Anforderungen; kleines LLM und erweiterter Kontext ausschließlich für selbst autorisierte KI-Plugins sind Betreiberziel, keine hier nachgewiesene neue Modell-/Kontextimplementierung.

`cdb0644` mit OFF/ON/AI bleibt laut Betreiber ausdrücklich bestehen (`R4-P2-UI-PROJECTION`); OFF/STBY/ON liegt nur im BACKLOG-Abschnitt von DEPLOY_TODO.md. Keine erneute UI-Projektionsänderung.

### Runde 5 – widerrufbare KI-Delegation (2026-11-13)
Die oben dokumentierte Runde-4-Sperre ist historisch. Der Betreiber hat den Race-Fix und die getrennte Delegation ausdrücklich beauftragt: „OFF und KI geben Lock frei. KI übernimmt wie ein anderer User, widerrufbar, ohne den menschlichen Lock zu blockieren.“ Belege: `R5-P1-RACE-FIX`, `R5-P2-VERIFY`, `R5-P2-REAL-SIGNALING`.

Der Server erzeugt nur für den aktuellen menschlichen Halter eine kanonische Plugin-Delegation mit Nutzer, KI-Rolle, zufälliger Generation und Ablaufzeit (Standard 10 Minuten). Er setzt KI und gibt den Lock in derselben synchronen Koordinator-Transaktion frei. Neue Übernahme, OFF/manuelles ON, Ablauf, Verlassen oder Sessionwechsel widerrufen die Generation. Vor jedem Schritt prüft der Executor nach dem WRITE-await erneut Signal und serverbestätigte Generation/Ziel/Actor/Modus. Ein laufender Schritt darf kooperativ enden; spätere Schritte und verspätete Einstellungen der alten Generation werden abgewiesen. Verzögerte Settings behalten die beim Schreiben erfasste Generation. Kein Ziel `ai` oder `mixer`, keine globale Automatik. aiMONK bleibt ein ausdrücklich abgesendetes manuelles Eingabefeld.

Betriebsgrenze: Die Delegationsablage ist absichtlich flüchtig und an **einen** Koordinator gebunden. Mit Redis-Locks ist die Erteilung fail-closed gesperrt; vor mehreren Koordinatoren ist ein atomarer gemeinsamer Delegationsspeicher erforderlich. Ein Neustart, Restore oder Session-Ende stellt keine Delegationen wieder her. Für master bleibt zusätzlich die mixer-Halterberechtigung nötig; Mixer-Übergabe widerruft diese Delegation sofort. Dies ist keine Freigabe für den produktiven Redis-Verbund oder B3.

### 2.3 AI-Flotte (Abgleich 2026-11-13)
FLUX/Wan/Trainingsstarter endgültig entfernt am 2026-11-13 auf Betreiberentscheidung. Grund: nur ein Visuals-Live-Renderer aus vorhandenen Medien. Kein Ersatz geplant. Freeze-Ausnahme abgeschlossen; Belege `LIVE-T0-DECISION`, `R3-T0C-FINAL-REMOVAL`.

Der konfigurierte GPU-Provider ist Vast (`deploy/gpu-provider.json`, Dispatcher `scripts/gpu-pods.py`); die frühere RunPod-Starttabelle ist keine aktuelle Betriebsspezifikation. Aktueller Produktionsbestand ausschließlich: `docs/SERVER_FLEET.md`. Konfigurationsquellen, Startbedingungen und offene Readiness-Nachweise: `docs/AI_FLEET_STARTPLAN.md`. Fehlender Inventarzugang belegt keine leere Flotte.

---

## 3. Mandatory Plugin Catalog & Specifications

You are tasked with maintaining, improving, or developing the following plugin ecosystem:

### #1 Mischpult (DJ Mixer)
* **Spec:** 5-channel DJ mixer with A/B deck assignment (effectively 10 channels).
* **Aesthetics:** Styled after a modern Pioneer DJ hardware mixer.
* **Control:** Native, zero-configuration Plug & Play mapping for all standard MIDI controllers.

### #2 Sequenzer
* **Spec:** Modern touch-optimized step-sequencer.
* **Grid:** 16 bars/steps horizontally, 8 tracks/channels vertically.
* **Aesthetics:** Vividly color-coded matching high-end hardware production gear.

### #3 Sample- & Sound-Bibliothek (Library)
* **Spec:** Central repository for all assets. Fully loaded with high-end samples, full tracks, add-ons, and AI prompts.
* **Behavior:** Any newly generated audio, stem, or preset must automatically and silently save to this library in the background.

### #4 Drum-Machines & Synths (Junket)
* **Spec:** Fully functional emulations of classic electronic and techno hardware.
* **Mandatory Inclusions:** Accurate functional replicas of the Dirtywave M8, Roland TR-808, and similar iconic gear.

### #5 Instrumenten-Plugins
* **Spec:** Multi-instance capable asset pool containing a pre-selection of at least 50 standard instruments (e.g., Violin, Piano, Guitar, Drums, Trombone, Theremin, etc.).
* **Requirement:** 100% acoustic authenticity in sound generation and mathematically correct interface controls.

### #6 Spatial Surround Audio
* **Spec:** Panning array for multi-channel/surround speaker setups.
* **Function:** Interactive 2D vector path movement for individual stems or the entire spatial audio mix.

### #7 Equalizer (EQ)
* *Status:* Finished. Maintain API stability and visual integration.

### #8 Mastering Tool
* *Status:* Finished. Maintain absolute priority on low-latency audio delivery to this node.

### #9 MIDI Controller Profiles
* **Spec:** Visual and functional profiles for the industry's most common MIDI controllers.
* **Requirement:** Real-time hardware integration via Plug & Play with full visual mirroring on screen.

### #10 Effektmaschine (FX Engine)
* **Spec:** Multi-FX unit capable of emulating the routing, algorithms, and characteristics of top-tier hardware effects processors.

### #11 Remix & Cover Stem Extractor
* **Spec:** Audio import utility. Automatically analyzes uploaded songs and splits them into **5 discrete stems**:
  1. Vocals (Gesang)
  2. Lows (Tiefen / Bass)
  3. Mids (Mitten)
  4. Highs (Höhen)
  5. Melody (Melodie)
* **Automation:** On import, the plugin must automatically warp, time-stretch, and analyze the audio to match the current running project's BPM and key attributes. Outputs are saved to the Library.

### #12 Voice Generator (AI Vocalist)
* **Spec:** AI-driven text-to-speech and text-to-singing plugin.
* **Interface:** Prompt inputs, selection masks, and style presets. Works seamlessly as an automated sample assistant.

### #13 Open Extension Slot
* **Spec:** Keep the plugin registry architecture open to modularly inject further utilities tailored for producers, live DJs, and sound engineers.

### #14 Master Recorder
* **Spec:** Bit-perfect capture & export des finalen Mixes.

### #15 DSP Engine
* **Spec:** Worklet-Automation (Cutoff/Resonance/ModIndex/Gain/LFO) + Stimmen-Monitoring.

### #16 Visualizer
* **Spec:** OffscreenCanvas-Waveform-Visualizer im Web Worker.

### #17 Performance-Monitor
* **Spec:** Echtzeit-FPS/Jitter/Latenz-Budgets (Slot 17).

---
## 4. Development Workflow Rule
Before submitting any Pull Request or completing a code generation task, verify:
1. Did I introduce latency?
2. Does this break the 4-user real-time state synchronization?
3. Is the plugin locking mechanism (B2B mode) preserved?
4. `npm run verify` ist grün. Die Kette hat 10 Gates – typecheck, lint, test, test:python,
   security, audio:gate, audit:rt:gate, test:rls, check:deadfiles, audit:deep:static – und endet mit
   `npm run verify:summary`, das übersprungene Gates namentlich nennt (heute: `test:rls`, wenn
   `SB_URL`/`SB_SERVICE_ROLE` fehlen). Welche Gates wo laufen (verify / ci.yml / nightly) und welche
   Secrets sie brauchen, steht in `docs/VERIFY_MATRIX.md`.
5. Keys bleiben serverseitig – keine Secrets in Client-Code oder Bundles.

---

## 5. Canonical Plugin Architecture

audioMONASTRY has exactly 16 canonical plugin adapters:

`mixer`, `drop`, `song`, `effect`, `syntisampler`, `drumsampler`,
`instru`, `biblio`, `voice`, `sound`, `stem`, `spatial`,
`eq`, `dsp`, `master`, `record`.

`mastergraph`, `ai`, `performance`/`perfor` and system-level
controller functionality are not counted as canonical audio plugins.

All canonical plugins must implement the shared runtime contract:

- `initialize(context)`
- `setState(state)`
- `setParameter(parameter)`
- synchronous `process(audioBlock)`
- asynchronous `handleCommand(command)`
- `snapshot()`
- `restore(snapshot)`
- idempotent `dispose()`

Rules:

- `OFF` must be a transparent bypass.
- No network, storage, React state update or blocking lock operation inside `process()`.
- Time-critical DSP must use the existing AudioWorklet/WASM/audio backend boundaries.
- Plugin UI must not own the canonical audio runtime state.
- All mutating commands require the centralized human lock or a current server-attested plugin delegation; existing Main-out holder restrictions also apply.
- Legacy plugin IDs must resolve through explicit aliases (`src/plugins/legacyAliases.ts`).
- `npm run verify` must remain green.

### Namensregel (Betreiber 2026-10-07)
**Player / Master-Player ist ausschließlich mixerMONK.** Die feste Anzeige oben heißt **mastergraphMONK** (reine Ansicht des Main-Ausgangs, keine Eingaben, kein Transport). Der Backend-Dienst `master-player` (FFmpeg-Mixing/Mastering) trägt seinen Namen als Infrastruktur weiter.

### Runde 5 – Live-Verifikation und Artefakte (2026-11-13)
Betreiberentscheidung: **50 EUR pro Testsession**, ersetzt den historischen 30-EUR-Cap. Der Collector prüft vor Start und alle 30s ausschließlich vollständige, aktuelle EUR-Istkosten derselben Session; Tarifschätzungen, Fremdscope und fehlende Daten führen zum Stopp. Explizite Simulationskosten sind nur im ausgewiesenen lokalen Proof zulässig. Rohdaten werden append-only alle 10s mit fsync und atomarem Checkpoint gesichert, vor SIGTERM an den ausdrücklich gewählten eigenen Testprozess nochmals geflusht. Alte Rohdatendateien werden nicht überschrieben.

Netzwerk-Abbruchmetrik: pro Empfänger/Peer im rollenden 30s-Fenster Summe concealedSamples / Summe totalSamplesReceived (Intervall-Deltas); >20% stoppt. Das ist keine DSP-Block-Glitchrate. `glitchRate` bleibt ohne Blockzähler null / „nicht gemessen“. Handover wird am Output über echte RTP-Zustellung bei Ownerwechsel beobachtet; >5s stoppt auch vor Wiederkehr. Ohne Output/aktive Zustellung bleibt dieser Nachweis unbekannt. Keine PA-Latenz aus RTP/JavaScript-Uhren ableiten.

Origin-Health meldet den tatsächlich gestarteten Mediasoup-Worker-/Routerstatus separat; HTTP-Liveness allein ist kein SFU-/WAN-Mediennachweis. B3 bleibt bis zum grünen Gesamtprüfstand, erlaubten Merge, gültigem Istkostenkanal und belastbarer Live-Telemetrie gesperrt. Die fünf geschützten Checks, Audio-/RT-Gates, DSP und sechs Domain-Defaults bleiben unverändert. Kein Wiederholen von RT-/Heapprüfungen bis grün.

8 Instanzen / 7 Images / 22 Manifest-Einträge sind in Runde5 bestätigt. Eine Produktions-Buildquelle: `Dockerfile.vast`, ausgewählt durch `deploy/vast/build-contract.json`, mit eigener YuE2-Stufe. Tests prüfen dieselbe Datei. Neue Allokation verlangt exakt die sieben gebauten Registry-Digests, das unveränderte Voice/Music-Sharing und einen passenden Build-Quellfingerprint. Bestehende alte Image-Digests sind keine Attestierung des neuen Quellstands. Keine Provisionierung bis zur erfolgreichen Attestierung. Keine FLUX-/Wan-/Trainingsstarter und keine zusätzlichen SD-Turbo-/LCM-Gewichte unter unveränderter22er-Liste.

Runde5-Abschlussbelege: sieben tatsächlich gebaute und geprüfte Images im erfolgreichen Lauf43487555348, Artefaktcommit3760804, Audit-IDs `R5-IMAGE-<role>-2509042c9d52`. M2-Build-/Digestzulassung nachgewiesen; GPU-/Renderer-Co-Last unbekannt. Die Plugin-Komponenten des delegierenden Nutzers bleiben während seines KI-Grants verborgen gemountet und sind nach Generation getrennt; fremde Nutzer starten keine Kopie. Asynchrone Settings-Effekte verwenden den eigenen gültigen Grant, ältere Ausführungskontexte dürfen keine neuere Generation annehmen; Serverablehnungen lösen Resync aus. Unveränderte Grant-Metadaten dürfen keine Controller-Lebenszeit neu starten. Nach der asynchronen Schritt-Autorisierung folgt nochmals eine synchrone Prüfung direkt am Dispatch (`R5-P1-FINAL-SYNCHRONOUS-FENCE`). Die alte rote Heapprüfung bleibt rot; weder Merge noch B3-Freigabe aus den grünen Image-/Teiltests ableiten.

### Runde 6 – Diagnose und B3-Vorbereitungsstand (2026-11-13)
`fix/b3-preparation-round6` baut direkt auf Runde5/e64e3f4 auf; kein main-Merge,
kein Rückmerge und kein B3-Start. `R6-P1-ORIGINAL-ISOLATED` / `R6-P1-RAW-AND-SNAPSHOTS`:
isolierter Originalfall einmal grün, getrennte Probe616B, ursprüngliche480616B-Ursache
weiter ungeklärt. Originaltest, DSP und16384B-Grenze unverändert; breiter Befund bleibt
Blocker. Diagnosevorschlag im bestehenden Runde2-Bericht, keine Abschwächung.
`R6-P2-FAIL-CLOSED`: Simulation nur explizite Test-Fixture, keine Freigabe über ENV
im Produktivsammler. Tatsächlicher Hetzner-Sessionkostenkanal fehlt nach API-Prüfung
(`R6-P2-HETZNER-ACTUAL-BLOCKED`);50EUR unverändert, B3 gesperrt.
`R6-P3-REAL-RTP-FOUR-CONTEXTS`: echte lokale RTP-Samplezähler mit vier Senderkontexten,
67,973s Empfangsspanne inklusive Lücken, drei Übergaben. Kein WAN-/SFU-Medien-/PA-
oder Block-Glitch-Nachweis. Der erste echte Handover-Guard-Stopp bleibt dokumentiert.
Externe503/Hetzner-Restore und GPU-Inferenz sind außerhalb dieser Runde.
