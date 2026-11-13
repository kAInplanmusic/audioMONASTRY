# A3 – Clock-Sync-Prüfung

## Ergebnis und DoD

**✅ Die Clock-Sync-Schicht existiert im Quellcode.** Die A3-DoD ist durch die untenstehende Datei:Zeile-Kette erfüllt. Dies ist eine statische Codeprüfung der angegebenen Basis, kein Nachweis synchroner Audioausgabe auf laufenden Geräten.

| Schritt | Beleg | Feststellung |
| --- | --- | --- |
| Auslösung | `src/App.tsx:296–309` | Effect registriert Pong-Listener, pingt sofort und alle 15 Sekunden; Cleanup entfernt Listener und Timer. |
| Client-Sendezeit | `src/utils/WebRTCManager.ts:140–143` | Bei verbundenem Socket wird `clock-ping` mit `t0 = performance.now()` gesendet. |
| Serverzeit | `server/realtime.ts:133–135`, `server/realtime.ts:454–457` | Server übernimmt `t0`, setzt `t1` und `t2` auf denselben `Date.now()`-Wert und antwortet per Ack oder `clock-pong`. |
| Empfang | `src/utils/WebRTCManager.ts:538`, `src/App.tsx:297–299` | Pong wird an Listener weitergereicht; App ergänzt `t3 = performance.now()` und ruft `applyServerClock` auf. |
| NTP-artige Formel | `src/utils/ClockSync.ts:34–42` | Berechnet RTT `(t3-t0)-(t2-t1)` und Offset `((t1-t0)+(t2-t3))/2`; negative RTT behält alten Offset. |
| Drift/Diagnose | `src/core/clock/MonastryMasterClock.ts:132–148` | Prüft endliche Werte, speichert Offset, RTT, Offsetänderung und Messzähler; führt ab zweiter Messung PLL mit Offsetänderung aus. |
| Offset-Nutzung | `src/utils/captureRelayBridge.ts:58–60`, `src/core/capture/captureRelayBridge.ts:250–257`, `src/core/capture/captureRelay.ts:226–228` | Capture-Relay erhält Serveroffset/RTT und rechnet fremde Serverzeitstempel in lokale AudioContext-Zeit um. |
| Lokale Audiozeit/PDC | `src/core/audio/live/V2SampleClock.ts:109–126` | Sample-Clock erzeugt Steps anhand Sample-Rate/BPM und zieht lokale PDC-Samples ab. Dies allein belegt keine Clock-Synchronität zwischen Geräten. |

## Grenzen und Auffälligkeiten außerhalb des A3-Scopes

- Live-Verbindung, tatsächlich eintreffende Pongs, Offsetgenauigkeit und hörbare Drift zwischen Geräten bleiben **unbekannt**: Es wurde kein laufender Server oder Browser vermessen. Die folgenden Befehle lesen ausschließlich lokale Quellen.
- `applyServerClock` verändert in seiner Implementierung nur Clock-Zustand und PLL (`src/core/clock/MonastryMasterClock.ts:132–148`); es ruft dort keine Korrektur der Audio-Engine auf. Aus dem Namen „Clock-Sync“ folgt deshalb kein Nachweis samplegenauer Geräteausgabe.
- Der Server setzt `t1` und `t2` auf denselben Wert (`server/realtime.ts:135`), misst also keine getrennte Empfangs-/Sendezeit.
- Bereits vorhandene Tests beschreiben Formel, Server-Echo und Diagnosen (`tests/clockSyncNtp.test.ts:15`, `:41`, `:54`). Sie wurden für diese reine Existenzprüfung nicht ausgeführt; es wird kein Testerfolg behauptet.
- Kein Runtime-Code, keine Infrastruktur und keine Registry geändert. Die DoD erlaubt den positiven Implementierungsnachweis direkt per Datei:Zeile; ein negativer Registry-Eintrag „existiert nicht“ wäre hier falsch.

## Reproduzierbare Suchbelege

Ausgeführt im Repository-Worktree; Exitcodes und Ausgaben wurden unverändert übernommen. Alle folgenden Befehle sind lesend.

### `git rev-parse HEAD`

Zeit: `2026-11-13T07:18:54.963634+00:00`. Exitcode: `0`.

```text
5193d9e33142c00edd67712fc2f605a722e66db7
```

### `rg -n 'clock-ping|clock-pong|sendClockPing|applyServerClock|15_000' src/App.tsx src/utils/WebRTCManager.ts server/realtime.ts`

Zeit: `2026-11-13T07:18:54.969338+00:00`. Exitcode: `0`.

```text
src/App.tsx:299:      masterClock.applyServerClock({ t0: d.t0, t1: d.t1, t2: d.t2, t3: performance.now() });
src/App.tsx:302:      webRTCManager.sendClockPing();
src/App.tsx:303:    }, 15_000);
src/App.tsx:304:    webRTCManager.sendClockPing();
src/utils/WebRTCManager.ts:126:   * `sendClockPing()` schickt t0, der Server antwortet mit t1/t2, t3 entsteht beim
src/utils/WebRTCManager.ts:127:   * Empfang - die Auswertung macht `masterClock.applyServerClock`.
src/utils/WebRTCManager.ts:140:  public sendClockPing(): boolean {
src/utils/WebRTCManager.ts:142:    this.socket.emit('clock-ping', { t0: performance.now() });
src/utils/WebRTCManager.ts:537:    // Clock-Sync: Antwort des Servers an die Horcher weitergeben (siehe sendClockPing).
src/utils/WebRTCManager.ts:538:    this.socket.on('clock-pong', (data: any) => this.clockPongListeners.forEach((l) => l(data)));
server/realtime.ts:65: * (reines Echo ohne Zustand - siehe `socket.on('clock-ping')`).
server/realtime.ts:454:      socket.on('clock-ping', (data: unknown, ack?: (answer: unknown) => void) => {
server/realtime.ts:457:        else socket.emit('clock-pong', answer);
```

### `rg -n 'handleServerPong|const rtt|this.offset =|getSyncedTime|performance.now' src/utils/ClockSync.ts`

Zeit: `2026-11-13T07:18:54.976284+00:00`. Exitcode: `0`.

```text
8:    const start = performance.now();
13:    const now = performance.now();
16:    this.offset = (pongTime - pingTime) - (this.rtt / 2);
23:   * `performance.now()`) und liefert damit keinen belastbaren Offset. Der
34:  public handleServerPong(t0: number, t1: number, t2: number, t3: number): number {
35:    const rtt = (t3 - t0) - (t2 - t1);
41:    this.offset = ((t1 - t0) + (t2 - t3)) / 2;
50:  public getSyncedTime(): number {
51:    return performance.now() + this.offset;
```

### `rg -n 'applyServerClock|handleServerPong|lastOffset|offsetDriftMs|syncCount|pll.update|getServerOffsetMs' src/core/clock/MonastryMasterClock.ts`

Zeit: `2026-11-13T07:18:54.986734+00:00`. Exitcode: `0`.

```text
30:  offsetDriftMs: number;
32:  syncCount: number;
54:  private offsetDriftMs = 0;
55:  private syncCount = 0;
56:  private lastOffset = 0;
119:    this.pll.update(offset);
123:   * Wendet eine Clock-Messung an (NTP-Formel, siehe ClockSync.handleServerPong).
126:   * sendete je einen Ping - `syncCount` blieb 0 und der Offset damit wirkungslos.
132:  public applyServerClock(payload: { t0?: unknown; t1?: unknown; t2?: unknown; t3?: unknown }): number {
137:    if (![t0, t1, t2, t3].every((v) => Number.isFinite(v))) return this.lastOffset;
138:    const previous = this.lastOffset;
139:    const offset = this.clockSync.handleServerPong(t0, t1, t2, t3);
140:    this.lastOffset = offset;
141:    this.offsetDriftMs = Math.round((offset - previous) * 10) / 10;
143:    this.syncCount += 1;
145:    if (this.syncCount > 1) {
146:      this.pll.update(this.offsetDriftMs);
155:  public getServerOffsetMs(): number {
156:    return this.lastOffset;
171:      pllOffsetMs: Math.round(this.pll.update(0) * 10) / 10,
174:      offsetDriftMs: this.offsetDriftMs,
175:      syncCount: this.syncCount,
```

### `rg -n 'serverOffsetMs|serverMsToCtxSec|remoteInputCtxSec|receiverCompensationMs|senderListenLagMs' src/utils/captureRelayBridge.ts src/core/capture/captureRelay.ts src/core/capture/captureRelayBridge.ts`

Zeit: `2026-11-13T07:18:54.992738+00:00`. Exitcode: `0`.

```text
src/utils/captureRelayBridge.ts:59:      serverOffsetMs: () => masterClock.getServerOffsetMs(),
src/core/capture/captureRelayBridge.ts:29:  receiverCompensationMs,
src/core/capture/captureRelayBridge.ts:30:  remoteInputCtxSec,
src/core/capture/captureRelayBridge.ts:31:  senderListenLagMs,
src/core/capture/captureRelayBridge.ts:55:  serverOffsetMs(): number;
src/core/capture/captureRelayBridge.ts:163:    const offset = this.clock.serverOffsetMs();
src/core/capture/captureRelayBridge.ts:165:    const lagMs = senderListenLagMs({
src/core/capture/captureRelayBridge.ts:251:    const offset = this.clock.serverOffsetMs();
src/core/capture/captureRelayBridge.ts:253:    const comp = receiverCompensationMs(lagMs, { rttMs: this.clock.rttMs(), outputLatencyMs: lat.outputLatencyMs, baseLatencyMs: lat.baseLatencyMs });
src/core/capture/captureRelayBridge.ts:257:        const t = remoteInputCtxSec(e.serverMs, comp, ctxNow, perfNow, offset);
src/core/capture/captureRelay.ts:160: * (`remoteInputCtxSec`) - der Server kann das nicht.
src/core/capture/captureRelay.ts:226:export function serverMsToCtxSec(serverMs: number, ctxNowSec: number, perfNowMs: number, offsetMs: number): number {
src/core/capture/captureRelay.ts:241:export function senderListenLagMs(p: { rttMs?: number; outputLatencyMs?: number; baseLatencyMs?: number; jitterBufferMs?: number }): number {
src/core/capture/captureRelay.ts:246:export function receiverCompensationMs(senderLagMs: number, p: { rttMs?: number; outputLatencyMs?: number; baseLatencyMs?: number }): number {
src/core/capture/captureRelay.ts:254:export function remoteInputCtxSec(serverMs: number, compensationMs: number, ctxNowSec: number, perfNowMs: number, offsetMs: number): number {
src/core/capture/captureRelay.ts:255:  const t = serverMsToCtxSec(serverMs - compensationMs, ctxNowSec, perfNowMs, offsetMs);
```

### `rg -l -i 'clock|sync|drift|timestamp|ntp|AudioContext.currentTime|performance\.now|latency.?compensation' src/core/clock src/utils/ClockSync.ts src/utils/PhaseLockedLoop.ts src/core/audio/live/V2SampleClock.ts src/core/audio/live/v2Pdc.ts tests/clockSyncNtp.test.ts`

Zeit: `2026-11-13T07:18:54.996749+00:00`. Exitcode: `0`.

```text
src/utils/ClockSync.ts
src/core/audio/live/V2SampleClock.ts
tests/clockSyncNtp.test.ts
src/core/audio/live/v2Pdc.ts
src/utils/PhaseLockedLoop.ts
src/core/clock/MonastryMasterClock.ts
src/core/clock/MasterClock.ts
src/core/clock/clockAudit.ts
```

## Änderungen und Übergabe

Geänderte Datei: ausschließlich dieser Bericht. Branch: `fix/a3-clock-sync`, Basis: `main` mit dem oben protokollierten Commit. Kein Push und kein Merge. Zur Orchestratorprüfung die protokollierten `rg`-Befehle erneut ausführen und die aufgeführten Quellstellen lesen.
