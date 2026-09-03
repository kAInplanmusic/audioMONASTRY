# audioMONASTRY – Tiefen-Audit

**Datum:** 2026-09-03 · **Commit:** `7b22c18` · **Version:** 1.10.1
**Umfang:** Frontend/State-Sync, Audio-Engine/DSP, Backend/Security, Build/CI/Qualität, Architektur-Compliance
**Methode:** Statische Code-Analyse + Ausführung aller vorhandenen Gates (`tsc`, Vitest, Coverage, Boundary-Scan, Memo-Scan, Bundle-Budget, `npm audit`, Prod-Build). Jeder Befund unten wurde am realen Code verifiziert (Datei + Zeile).

---

## 1. Executive Summary

Das Projekt ist in **gutem strukturellem Zustand**: alle harten Gates sind grün (654 Tests, 0 TS-Fehler, 0 Boundary-Verstöße, Prod-Build erfolgreich), die DSP-Worklets sind überdurchschnittlich sorgfältig geschrieben (NaN-/Denormal-Guards, Lookup-Tabellen statt `Math.exp` im Hot-Path, PDC für den 5-ms-Lookahead des Masterings), und der Server hat eine solide Sicherheits-Grundlinie (Konstantzeit-Token-Vergleich, Streaming-Upload mit Limits, Rate-Limiting, RBAC + Audit-Log).

**Die kritischste Erkenntnis betrifft aber genau das Kern-Architekturversprechen des Projekts: das B2B-/Locking-Modell ist faktisch nicht funktionsfähig.**

1. **Locks werden nie über das Netzwerk repliziert** – `PluginManagerContext` ist reiner Browser-lokaler State. User B sieht nie, dass User A ein Plugin hält.
2. **Der Lock-Owner-Vergleich ist reihum falsch**: Locks werden mit `webRTCManager.userId` (`user-ab12cd`) gesetzt, aber in ~20 Komponenten gegen das Literal `'localUser'` verglichen. Ergebnis: Der eigene Lock erscheint als Fremd-Lock → der User sperrt sich selbst aus dem Plugin aus, das er gerade auf PRO gezogen hat.
3. **`releaseLock()` ignoriert den User** – jeder darf jeden Lock freigeben.
4. **Vier konkurrierende Lock-Implementierungen** existieren parallel (`PluginManagerContext`, `collab.ts`, `hubConnector.ts`, `useWebRTC.ts` – letztere ist toter Code).

Zweitwichtigster Cluster: **Fehler-/Informations-Leaks im Server** (`(e as Error).message` geht 1:1 an den Client, inkl. Supabase-Schema-Details) und **fehlende Ziel-Validierung in Socket.io-Relays**.

| Bereich | Bewertung | Kernproblem |
|---|---|---|
| Build/CI/Gates | 🟢 gut | Bundle-Budget-Warnung (1.56 MB > 1.50 MB) |
| Audio-Engine/DSP | 🟢 gut | LUFS-`log10(0)`, `audioEngine.ts` mit 2814 Zeilen |
| Backend/Security | 🟡 mittel | Error-Leaks, unvalidierte Socket-Ziele, `qs`-CVEs |
| Frontend/React | 🟡 mittel | Toter Code, 160× `any`, Memo-Gate rot |
| **Multi-User-Sync / B2B-Locking** | 🔴 **kritisch** | **Locking netzwerkweit unwirksam** |
| Test-Abdeckung | 🟡 mittel | 32.6 % Statements; Kernpfade untertestet |

---

## 2. Gemessene Fakten (reproduzierbar)

| Gate | Kommando | Ergebnis |
|---|---|---|
| TypeScript | `npm run lint` | ✅ 0 Fehler |
| Unit/Integration | `npm run test` | ✅ 109 Dateien / 654 Tests grün (15.4 s) |
| Interface-Boundary | `node scripts/validate-interface-boundaries.mjs` | ✅ 322 Dateien, 0 Verstöße |
| React-Memo-Gate | `node scripts/check-react-memo.mjs` | ❌ `DropTerminal.tsx` ohne `React.memo` |
| Bundle-Budget | `node scripts/check-bundle-size.mjs` | ⚠️ 1.56 MB / 38 JS-Dateien (Warn 1.50, Fail 2.00) |
| Prod-Build | `npm run build` | ✅ inkl. 12 Worklets + `dist/server.cjs` (160.7 kB) |
| Dependency-Audit | `npm audit` | ⚠️ 3 moderate (`qs` → `body-parser` → `express`) |
| Coverage | `npm run test:coverage` | ⚠️ Statements 32.64 %, Branches 26.26 %, Functions 31.17 %, Lines 34.32 % |

**Code-Hygiene:** 341 Dateien / 46 578 Zeilen in `src`; 160× `any`/`as any`; 3× `@ts-ignore`/`@ts-expect-error`; nur 2 TODO/FIXME; 22× `console.log`; 14 E2E-Specs; 49 Dokumente in `docs/`.
**Größte Dateien:** `src/utils/audioEngine.ts` (2814), `src/App.tsx` (773), `src/components/SpatialScene.tsx` (690), `src/core/adapters.ts` (650), `src/utils/WebRTCManager.ts` (550).
**Größter Chunk:** `dist/assets/index-*.js` = 1228 kB (dazu 404 kB `ort.bundle.min` lazy).

---

## 3. Kritische Befunde (P0)

### K-1 · Lock-Owner-Vergleich gegen falsches Literal – User sperrt sich selbst aus
**Schwere:** Kritisch · **Bereich:** Multi-User/B2B
**Fundstellen:** `src/App.tsx:677`, `src/components/ModuleContainer.tsx:19`, `McpTerminal.tsx:44`, `EQPluginTerminal.tsx:227`, `RecorderTerminal.tsx:67,148,210`, `StemExtractorTerminal.tsx:70,194`, `VoiceGenTerminal.tsx:63,120`, `MischpultTerminal.tsx:88`, `DrumMachineTerminal.tsx:47`, `InstrumentsTerminal.tsx:126,143,181`, `DSPTerminal.tsx:127`, `MIDIControllerTerminal.tsx:153`, `CustomSlotTerminal.tsx:17,32,42`, `FXEngineTerminal.tsx:46` (~20 Dateien).

Locks werden mit der Session-Identität gesetzt (`requestLock(id, webRTCManager.userId)` in `src/App.tsx:253,267`), und `webRTCManager.userId` ist `user-<random>` (`src/utils/WebRTCManager.ts:17-22`). Die UI prüft aber überall `lockStatus.lockedBy !== 'localUser'`. Da `lockedBy` nie `'localUser'` ist, ist `lockedByOther` **immer true, sobald ein Lock aktiv ist** – auch für den Halter selbst. Der User, der ein Plugin auf PRO promotet, bekommt es sofort ausgegraut (`opacity-50 grayscale`) und alle Interaktions-Guards greifen gegen ihn.

**Fix:** Zentralen Helfer einführen (`isLockedByOther(lock, webRTCManager.userId)`) und alle Literal-Vergleiche ersetzen; Regressionstest im Stil von `tests/lockFuzz.test.ts` ergänzen, der genau diesen Owner-Fall abdeckt.

---

### K-2 · Plugin-Locks werden nicht repliziert – B2B-Mandat nicht erfüllt
**Schwere:** Kritisch · **Bereich:** Multi-User/B2B
**Fundstellen:** `src/context/PluginManagerContext.tsx:18-84`, `src/context/ModuleStateContext.tsx:63-104`.

`PluginManagerContext` hält Locks ausschließlich in lokalem React-State (`useState` + `locksRef`). Es gibt **keinen** Sende- oder Empfangspfad über `webRTCManager` bzw. den Socket.io-Relay. Repliziert wird nur der Modul-State (`PLUGIN_STATE_UPDATE`). Damit sieht kein zweiter User, dass ein Plugin gehalten wird – das im Architektur-Mandat geforderte „Locked Mode für die anderen 3 User" existiert netzwerkseitig nicht. Der Server hat mit `plugin-state` + RBAC (`server.ts:1777-1800`) bereits den passenden Kanal; er wird für Locks nicht genutzt.

**Fix:** Lock-Akquise/-Freigabe als eigene, serverseitig autoritative Nachricht (`plugin-lock`) über den bestehenden Session-Room replizieren; Server als Schiedsrichter (Lock-Tabelle je Session), Client nur optimistisch. Bestehende `sessionRoles`-Strukturen in `server.ts` sind ein natürlicher Ort dafür.

---

### K-3 · `releaseLock()` prüft den Halter nicht
**Schwere:** Kritisch (nach Behebung von K-2 direkt ausnutzbar) · **Fundstelle:** `src/context/PluginManagerContext.tsx:75-81`.

```
const releaseLock = useCallback((pluginId: string, _userId: string) => { ... })
```
Der Parameter `_userId` wird bewusst ignoriert; jeder Aufruf setzt den Lock hart auf `active: false`. `src/App.tsx:172,246` ruft das u. a. bei jedem `togglePlugin` auf. Sobald Locks repliziert sind, kann damit jeder User jeden fremden Lock brechen.

**Fix:** `if (lock?.lockedBy && lock.lockedBy !== userId) return;` vor dem Commit; Freigabe zusätzlich serverseitig autorisieren.

---

### K-4 · Lock-Halter kann seinen eigenen Plugin-State nicht mehr ändern
**Schwere:** Hoch/Kritisch · **Fundstelle:** `src/hooks/usePluginState.ts:26-31`.

```
const updateState = (newState: PluginState) => {
  if (!lockStatus.active) { setModuleState(...) }
};
```
Geprüft wird nur *ob* ein Lock aktiv ist, nicht *wer* ihn hält. In Kombination mit K-1 heißt das: Sobald irgendein Lock gesetzt ist, kann **niemand** – auch nicht der Halter – über den Hook den State wechseln. 18 Terminals nutzen diesen Hook.

**Fix:** `if (!lockStatus.active || lockStatus.lockedBy === webRTCManager.userId)`.

---

### K-5 · Keine Lock-Freigabe bei Verbindungsabbruch
**Schwere:** Hoch · **Fundstellen:** `src/context/PluginManagerContext.tsx:29-46`, `src/utils/WebRTCManager.ts` (peer-left-Pfad).

Locks verfallen ausschließlich über den TTL-Sweep (5 min, Intervall 30 s). Fällt ein User mitten in PRO aus (Netz weg, Tab-Crash), bleibt sein Plugin bis zu 5 Minuten für die Session blockiert. Der Server kennt `disconnect` (`server.ts:1664-1666`) und könnte sofort freigeben.

**Fix:** Serverseitige Lock-Tabelle mit Freigabe im `disconnect`-Handler; clientseitig auf `peer-left` reagieren. TTL bleibt als Fallback, aber deutlich kürzer (z. B. 60 s mit Heartbeat-Verlängerung).

---

## 4. Backend & Security

> Verifiziert gegen `server.ts` (1954 Zeilen), `server/**`, `services/**`, `Caddyfile`, `Dockerfile*`.

### S-1 · Rohe Exception-Messages gehen an den Client (Hoch)
`server.ts:455, 470, 496, 516, 554` u. a.: `res.status(500).json({ error: (e as Error).message })`. Damit landen interne Pfade, Drittanbieter-Fehlertexte und – im Cloud-Sync-Pfad – konkrete Supabase-Schema-Hinweise inkl. Verweis auf `database/schema.sql` beim Aufrufer.
**Fix:** Generische Fehlercodes nach außen (`{ error: 'internal', code: 'CLOUD_SYNC_FAILED' }`), Details nur via `console.error` serverseitig.

### S-2 · Socket.io-Relay ohne Ziel-Validierung (Hoch)
`server.ts:1668-1682`: `offer`, `answer`, `ice-candidate` leiten an `data.target` weiter, ohne zu prüfen, ob das Ziel im selben Session-Room ist oder überhaupt existiert. Ein authentifizierter Client kann beliebige Socket-IDs mit Signaling-Traffic beschicken.
**Fix:** Ziel-Socket über `io.sockets.sockets.get(target)` auflösen und `socket.data.sessionRoom` vergleichen; sonst verwerfen.

### S-3 · `assign-role` ohne Session-Zugehörigkeitsprüfung (Hoch)
`server.ts:1754-1774`: Die Admin-Rolle des Senders wird geprüft, aber nicht, ob `data.userId` überhaupt Mitglied derselben Session ist. `sessionRoles` ist eine globale Map → ein Admin kann Rollen für fremde/nicht existierende User-IDs setzen und damit den globalen Rollen-Zustand verunreinigen.
**Fix:** Ziel-User gegen die Room-Mitglieder validieren, bevor `sessionRoles.set(...)` läuft.

### S-4 · Admin-Token-Vergleich nicht konstantzeitig (Mittel)
`server.ts:1056-1060`: `req.headers['x-admin-token'] !== adminToken`. Für `STUDIO_ACCESS_TOKEN` existiert bereits `safeTokenEqual()` (`server.ts:197-205`) – der Admin-Pfad nutzt sie nicht. (Entschärfend: `/api` liegt hinter `apiLimiter`, 60 req/min.)
**Fix:** `safeTokenEqual()` auch hier verwenden; Endpoint zusätzlich in ein engeres Limit hängen.

### S-5 · SFU-`sessionId` aus der Handshake-Query ungeprüft (Mittel)
`server.ts:~1855`: `const sessionId = (socket.handshake?.query?.sessionId || 'main').toString();` fließt direkt in Raumnamen (`sfu-session:${sessionId}`). Kein Format-/Whitelist-Check.
**Fix:** `/^[a-zA-Z0-9_-]{1,64}$/` erzwingen, sonst `disconnect(true)`.

### S-6 · `VOICE_CLI` wird ungeprüft ausgeführt (Mittel)
`server.ts:~1288-1296`: Der Binärpfad kommt aus `process.env.VOICE_CLI` und wird per `execFile` gestartet. `execFile` verhindert Shell-Injection (gut), aber es gibt keine Allowlist für den Pfad und der Output-Dateiname ist mit `Date.now()` vorhersagbar.
**Fix:** Pfad-Allowlist + `crypto.randomBytes` im Dateinamen.

### S-7 · Keine Content-Security-Policy (Mittel)
`server.ts:174-182` setzt `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`; im `Caddyfile:46-54` zusätzlich HSTS. Eine CSP fehlt in beiden – der Kommentar im Code weist das als bewusst offen aus.
**Fix:** CSP mit `worker-src 'self' blob:`, `script-src 'self' 'wasm-unsafe-eval'`, `connect-src` auf Supabase/R2/SFU beschränkt – wegen Worklets/WASM/WebRTC schrittweise im Report-Only-Modus einführen.

### S-8 · `qs`-Kette verwundbar (Niedrig)
`npm audit`: 3 moderate Findings (GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g) über `qs` → `body-parser` → `express@4.22.2`. Fix ist verfügbar.
**Fix:** `npm audit fix` (Patch-Level innerhalb Express 4).

### S-9 · Redis-URL & Fleet-Map-URL ungeprüft (Niedrig)
`server.ts:~1638` (`createClient({ url: REDIS_URL })`) und `wireFleetFromPortal()` (`server.ts:65-85`, 8 s Timeout beim Start) validieren das Schema der URL nicht.
**Fix:** `new URL()`-Parsing mit Protokoll-Whitelist (`redis:`/`rediss:` bzw. `https:`).

### Positiv (Security)
- Konstantzeit-Vergleich `safeTokenEqual()` für `STUDIO_ACCESS_TOKEN` (`server.ts:197-205`), Auth-Middleware für alle `/api/*` außer `/health` (`server.ts:219-226`).
- Rate-Limiting zweistufig, Key = Studio-Token statt IP (`server.ts:229-253`) – korrekt für Multi-User hinter einer IP. `/api/upload/sample` ist über das Präfix `/api/upload` mit abgedeckt.
- Busboy-Streaming-Upload mit Größen-, Feld- und MIME-Limits statt Buffering.
- COOP/COEP `credentialless` sauber gesetzt (SharedArrayBuffer/WASM) – Voraussetzung für die Worklet-/ONNX-Pfade.
- Serverseitige RBAC inkl. Audit-Log für `assign-role` und `plugin-state`; PRO-Promotion nur für `admin`/`producer`.
- Dockerfile mit Non-Root-User; CI mit gitleaks-Secret-Scan und Google/Firebase-Import-Gate (`.github/workflows/build.yml`).
- Keine Secrets im Repo: alle Tokens kommen aus `process.env`; `.env.example`-Dateien enthalten nur Platzhalter.

---

## 5. Audio-Engine & DSP

### A-1 · `lufsProcessor`: `log10(0)` → `-Infinity` im Shared-Buffer (Hoch)
`src/audio/worklets/lufsProcessor.ts:21-25`: `const lufs = 20 * Math.log10(rms) - 0.691;` ohne Floor. Bei Stille ist `rms === 0` → `-Infinity` → `Math.round(-Infinity * 100)` → der `Atomics.store`-Wert ist unbrauchbar und die LUFS-Anzeige kippt. Alle anderen Worklets machen es richtig (`masteringProcessor.ts:204` nutzt `Math.max(truePeak, 1e-8)`).
**Fix:** `20 * Math.log10(Math.max(rms, 1e-8)) - 0.691` plus Clamp auf z. B. −70 dB.

### A-2 · `audioEngine.ts` ist ein 2814-Zeilen-Monolith (Mittel, Wartbarkeit)
Die Datei vereint Graph-Aufbau, Worklet-Instanziierung, Routing, Monitoring, Recording und Fallbacks. Coverage liegt bei **26.7 % Statements** – ausgerechnet im „Main Sound"-Pfad, der laut Architektur-Mandat der kritischste ist.
**Fix:** In Module schneiden (Graph-Aufbau / Worklet-Factory / Routing / Monitoring) und die Kernpfade gezielt testen. Kein Verhaltens-Change nötig, rein strukturell.

### A-3 · Fehlgeschlagene Worklets werden nicht entsorgt (Mittel)
`src/utils/audioEngine.ts:430-438`: `makeWorklet(...)` fällt bei Fehlern auf einen `GainNode` zurück. Ein teilinitialisierter `AudioWorkletNode` bleibt in dem Fall unverbunden im Speicher; ein `dispose()`-Pfad fehlt.
**Fix:** Fehlgeschlagene Nodes explizit `disconnect()`en und in einer Liste für den Teardown führen.

### A-4 · Mastering-Lookahead nicht per API abfragbar (Mittel)
Der 5-ms-Lookahead ist im `masteringProcessor` fixiert; der Monitor-Bus wird in `audioEngine.ts:129,494` passend kompensiert. Es gibt aber keinen Getter, über den Plugins die reale Latenz für eigenes PDC erfragen könnten – riskant, sobald weitere latenzbehaftete Nodes dazukommen.
**Fix:** `audioEngine.getLatencyBudgetMs()` mit Aufschlüsselung je Stufe; Wert im `PerformanceMonitorTerminal` anzeigen.

### A-5 · Allokationen im `process()`-Pfad bei Kanalzahl-Wechsel (Niedrig)
`masteringProcessor.ts:167-172` (`delayLine.push(new Float32Array(...))`, `scratch`) und `itSynthProcessor.ts:447` (`mixBuf`) allozieren beim ersten Block bzw. bei Kanal-/Quantum-Änderung. Amortisiert unkritisch (kein Per-Block-Alloc), aber ein Verstoß gegen die Zero-Alloc-Regel im Echtzeit-Thread.
**Fix:** Im Konstruktor auf Maximalkanäle/-quantum vorallozieren.

### A-6 · Quantum-Annahme 128 im EQ-Ramping (Niedrig)
`src/audio/worklets/eqProcessor.ts:55` rechnet Rampenschritte gegen die feste Konstante 128. Solange die Spezifikation 128 garantiert, unkritisch – bei künftigen Render-Quantum-Größen wird das Ramping falsch skaliert (Zipper-Risiko).
**Fix:** Quantum aus der tatsächlichen Blocklänge ableiten.

### A-7 · Keine Denormal-Clamps im Reverb-Feedback (Niedrig)
`src/audio/worklets/effectProcessor.ts:94-108`: Comb-/Allpass-Rückkopplung ohne `if (Math.abs(v) < 1e-20) v = 0;`. `dspProcessor.ts:144-145` macht es vorbildlich. Lange Hallfahnen können in Subnormal-Bereiche laufen (CPU-Spitzen).
**Fix:** Analoge Clamps nach jedem Delay-Line-Write.

### Positiv (Audio)
- Konsequente NaN-/Finite-Guards im `dynamicsProcessor` (Zeilen 327, 359, 371, 384-403).
- Release-Koeffizient über segmentierte Lookup-Tabelle statt `Math.exp` pro Block (`masteringProcessor.ts:31-55`).
- True-Peak-Schätzung mit linearer Interpolation (2×-Oversampling-Approximation) vor dem Limiter.
- PDC: Monitor-Bus exakt um die 5 ms Lookahead verzögert (`audioEngine.ts:129,494`).
- Robuste Fallback-Kette (Duck-Typing für `AudioContext`, Gain-Fallback statt Hard-Crash) – kein WSOD bei fehlenden Worklets.
- Sample-Rate wird aus dem Kontext gelesen, 48 kHz nur als Fallback-Konstante.
- Test-Rückendeckung durch `goldenAudio`, `workletRampAudit`, `dspQuality`, `masteringDynamics`, `spatialProcessor`.

---

## 6. Frontend, React & Architektur-Compliance

### F-1 · `src/hooks/useWebRTC.ts` ist toter Code mit eigener Lock-Semantik (Mittel)
Die Datei implementiert eine komplette zweite Signaling- und Lock-Schicht (WebSocket statt Socket.io, `lock_request`/`lock_status`), wird aber **nirgends importiert** (repo-weit nur die eigene Deklaration). Sie enthält zusätzlich echte Fehler (`peers` im Cleanup ohne Dependency, Zeile 37-40). Als „Vorlage" gelesen führt sie Folge-Arbeit in die Irre.
**Fix:** Löschen – oder bewusst zur Referenz-Implementierung für K-2 machen und dann tatsächlich verdrahten.

### F-2 · Vier parallele Lock-Modelle (Mittel, Architektur)
`PluginManagerContext` (UI-Quelle), `src/utils/collab.ts:60-132` (`useCollabSession`, rein lokal), `src/hubConnector.ts:12-52` (Lock-Map mit Rollen, korrekt owner-geprüft) und `useWebRTC.ts`. Nur `hubConnector` prüft den Halter beim Release. Die Redundanz ist die Wurzel von K-1…K-5.
**Fix:** Auf ein Modell konsolidieren (serverseitig autoritativ), die anderen entfernen oder als dünne Adapter darauf zurückführen.

### F-3 · Memo-Gate rot (Mittel)
`node scripts/check-react-memo.mjs` meldet `DropTerminal.tsx` ohne `React.memo`. Der DropTerminal-Chunk ist mit 50 kB der größte Lazy-Chunk; `App.tsx` rendert bei jedem BPM-/Playback-Tick neu.
**Fix:** `React.memo` ergänzen; Gate zusätzlich in `.github/workflows/build.yml` als Pflicht-Step aufnehmen (aktuell läuft nur `check:bundle`).

### F-4 · LWW-Merge ohne Payload-Validierung (Mittel)
`src/context/ModuleStateContext.tsx:75-104` prüft `state` gegen die drei erlaubten Werte (gut), validiert aber `pluginId` nicht gegen die verbindlichen 21 IDs aus `src/core/ai/orchestrator/evalMatrix.ts`. Ein Peer kann beliebige Plugin-IDs in die State-Map schreiben. In `ProjectContext` gilt Analoges für Track-/Spatial-Claims.
**Fix:** Eingehende IDs gegen `EVAL_PLUGIN_IDS` bzw. die Registry whitelisten.

### F-5 · Typsicherheit: 160 `any`-Stellen (Mittel)
Schwerpunkte in den Nachrichten-Handlern (`ModuleStateContext.tsx:75`, `ProjectContext.tsx:244`, `hooks/useSessionSync.ts:31`) und bei Browser-Feature-Detection (`AudioContext.tsx:221,251`). Gerade die Handler sind die Vertrauensgrenze zwischen Peers – dort ist `any` besonders teuer. `zod` ist bereits als Dependency vorhanden.
**Fix:** Zod-Schemas für alle DataChannel-/Socket-Payloads; `as any` bei Feature-Detection auf enge Typ-Guards eingrenzen.

### F-6 · Nicht-null-Assertions ohne Guard (Niedrig)
`src/context/AudioContext.tsx:112,177,194` (`crdtClockRef.current!`, `clockMergerRef.current!`, `pluginLwwRef.current!`) und `src/context/AccessContext.tsx:30` (`useContext(AccessContext)!` ohne Provider-Prüfung, anders als bei `usePluginManager`/`useModuleState`).
**Fix:** Explizite Guards mit sprechender Fehlermeldung.

### F-7 · Handler-Zuweisung statt Subscription (Niedrig)
`src/App.tsx:117-150`: `webRTCManager.onMainStream`/`onSessionUpdate` werden als Properties gesetzt und beim Unmount nicht zurückgesetzt. Bei einer Zukunft mit mehreren Consumern überschreiben sie sich still gegenseitig.
**Fix:** Auf das bereits vorhandene `addDataChannelListener`-Muster (Unsubscribe-Rückgabe) vereinheitlichen.

### F-8 · Accessibility (Niedrig, aber breit)
Rund 72 ARIA-Attribute auf 61 Komponenten. Fader/Knobs (`MasterPlayerTerminal`, `DJ4ChMixer`, `EQPluginTerminal`) haben überwiegend keine `role="slider"` + `aria-valuenow/min/max`; Toggle-Buttons kein `aria-pressed`. Der Locked-Zustand wird rein visuell (`opacity-50 grayscale`) kommuniziert – für Screenreader unsichtbar.
**Fix:** `aria-disabled` + `aria-label` beim Lock-Zustand mitgeben, Slider-Rollen ergänzen.

### Architektur-Compliance gegen das Projekt-Mandat
| Mandat | Stand |
|---|---|
| Orchestrator-Backend + Main Sound im Core | ✅ eingehalten (Server orchestriert, Audio läuft im Client-Graph) |
| Plugin-Entkopplung / Interface-Boundaries | ✅ 0 Verstöße, `DropAudioAdapter`-Muster sauber |
| 21 Plugin-IDs, Registry als Single Source | ✅ `evalMatrix.ts` ↔ `public/plugin-manifest.json` deckungsgleich |
| OFF / Auto-AI / Professional-State-Maschine | ✅ zentral in `ModuleStateContext`, Start-Silence-Regel greift |
| Bis zu 4 User, identisches Spiegelbild | 🟡 State repliziert, Locks nicht (K-2) |
| B2B-/Locked-Mode | 🔴 nicht funktionsfähig (K-1…K-5) |
| Ultra-Low-Latency, kontrolliertes Mastering-Delay | ✅ PDC vorhanden; Latenz-Budget nicht API-seitig abfragbar (A-4) |

---

## 7. Build, CI & Qualität

- **CI-Abdeckung ist gut:** `build.yml` fährt Build + Bundle-Budget + gitleaks + `tsc` + Vitest + Boundary-Scan + Spatial-Regression + E2E-Matrix (Chromium/Firefox/WebKit). Zusätzlich `nightly.yml`, `ai.yml`, `live-stress.yml`, `sonarcloud.yml`.
- **Lücke:** `npm run check:memo` läuft in keinem Workflow – deshalb konnte `DropTerminal` unbemerkt durchrutschen. Auch `npm audit` ist kein Gate.
- **Bundle:** 1.56 MB überschreitet die Warnschwelle. Hauptursache ist der 1228-kB-Hauptchunk; Terminals sind bereits lazy geladen. Kandidaten: `tone` und `lucide-react` gezielt splitten/tree-shaken.
- **Coverage 32.6 %** bei 654 Tests: Die Testanzahl ist gut, aber die riskantesten Dateien sind untertestet – `audioEngine.ts` 26.7 %, `WebRTCManager.ts` 26.0 %, `collab.ts` 46.8 %, `rbac.ts` 0 %, `AuditLogger.ts` 0 %, `dropAudioBridge.ts` 0 %, `audioAnalyzer.ts` 0 %, `presetStore.ts`/`opfs.ts` 0 %.
- **Doku:** 49 Dateien in `docs/` plus `MASTER_TODO.md` (65 offene Punkte), `COPILOTTODO.md`, `TASKDONE.md` (1076 Zeilen). Der Workflow (Nachweis + „→ TASKDONE") ist konsistent gepflegt; es existieren aber bereits mehrere ältere Audit-Dokumente (`docs/SECURITY_AUDIT.md`, `docs/PERFORMANCE_AUDIT.md`, `docs/ARCHITECTURE_AUDIT_2026.md`, `docs/UIUX_AUDIT_2026.md`) – dieses Dokument ergänzt sie, ersetzt sie nicht.
- **`rbac.ts` mit 0 % Coverage** ist bemerkenswert, weil RBAC sowohl client- als auch serverseitig sicherheitsrelevant ist.

---

## 8. Empfohlene Reihenfolge

**Sofort (P0 – Kern-Mandat wiederherstellen)**
1. K-1: Owner-Vergleich zentralisieren, ~20 `'localUser'`-Literale ersetzen.
2. K-4: `usePluginState.updateState` um Owner-Prüfung erweitern.
3. K-3: `releaseLock` gegen den Halter absichern.
4. K-2: Lock-Replikation serverseitig autoritativ über den bestehenden Session-Room.
5. K-5: Lock-Freigabe im `disconnect`-Handler; TTL als Fallback verkürzen.
6. Regressionstests: Owner-Fall, Fremd-Lock, Disconnect-Freigabe, 4-User-E2E.

**Kurzfristig (P1)**
7. S-1 Error-Sanitizing, S-2 Socket-Ziel-Validierung, S-3 `assign-role`-Scope, S-4 Konstantzeit-Admin-Token.
8. A-1 LUFS-Floor.
9. F-3 `React.memo` + `check:memo` als CI-Gate; `npm audit fix` (S-8).
10. F-1 `useWebRTC.ts` entfernen oder verdrahten.

**Mittelfristig (P2)**
11. F-4/F-5: Zod-Schemas an allen Peer-Vertrauensgrenzen.
12. A-2: `audioEngine.ts` modularisieren + Coverage für Kernpfade, `rbac.ts` testen.
13. Bundle unter 1.50 MB (Tone/Lucide-Splitting).
14. S-7 CSP (Report-Only → Enforce), S-5/S-6/S-9 Eingangs-Validierungen.
15. A-3…A-7 DSP-Feinschliff; F-6…F-8 React-Hygiene und Accessibility.

---

## 9. Methodik & Grenzen

- Alle Zeilenangaben beziehen sich auf Commit `7b22c18`.
- Nur statische Analyse und die im Repo vorhandenen Gates. **Nicht ausgeführt:** Playwright-E2E (`collab`, `live2browser`, `hardware`, `visual` sind in dieser Sandbox umgebungsbedingt nicht verlässlich), Hörproben, echte 4-User-Session, Hardware-/MIDI-Tests, Lasttests gegen die Hetzner-Flotte.
- Latenz-Aussagen sind aus dem Code abgeleitet (Lookahead, PDC, Alloc-Verhalten), **nicht gemessen**. Die offenen Messpunkte stehen in `MASTER_TODO.md` und `docs/LIVE_CHECKLIST_2026-09-02.md`.
- Es wurden im Rahmen dieses Audits **keine Code-Änderungen** vorgenommen.
