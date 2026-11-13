# A4 Runde 2 – Originalausgaben

Datum aller Ausführungen: 2026-11-13 UTC; `date -u +%FT%TZ` lieferte `2026-11-13T09:03:45Z`. Vitest-Startzeit benutzt die lokale Prozesszeit (UTC+1). Arbeitsverzeichnis `/workspace/work/round2-a4`; Node22 über PATH `/home/agent/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin`. Keine Secrets in den unten gespeicherten Ausgaben gefunden; keine Schwärzung nötig.

## point1-before.txt

Befehl: `gegen P0 8a2f1f9: npx vitest run tests/mainOutIsolation.test.ts`

```text

 RUN  v5.0.5 /workspace/work/round2-a4

 ❯ tests/mainOutIsolation.test.ts (2 tests | 2 failed) 25ms
   ❯ A4 mocked studio, studio, audio-output and visual-output peers (2)
     × sends main audio exclusively to server-attested audio output while keeping studio data channels 20ms
     × does not subscribe studio clients to SFU audio producers 3ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/mainOutIsolation.test.ts > A4 mocked studio, studio, audio-output and visual-output peers > sends main audio exclusively to server-attested audio output while keeping studio data channels
AssertionError: expected [ …(2) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   {
+     "track": {
+       "id": "main-audio",
+       "kind": "audio",
+     },
+   },
+   {
+     "track": {
+       "id": "main-video",
+       "kind": "video",
+     },
+   },
+ ]

 ❯ tests/mainOutIsolation.test.ts:51:44
     49|     manager.startMainStream(new Stream([audio, video]) as unknown as M…
     50|     const peers = (manager as any).peerConnections as Map<string, Peer…
     51|     expect(peers.get('b-studio')!.senders).toEqual([]);
       |                                            ^
     52|     expect(peers.get('c-studio')!.senders).toEqual([]);
     53|     expect(peers.get('b-studio')!.channels).toHaveLength(1);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  tests/mainOutIsolation.test.ts > A4 mocked studio, studio, audio-output and visual-output peers > does not subscribe studio clients to SFU audio producers
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times

Received:

  1st vi.fn() call:

    Array [
      "foreign",
    ]


Number of calls: 1

 ❯ tests/mainOutIsolation.test.ts:68:37


⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  1 failed (1)
      Tests  2 failed (2)
   Start at  09:59:53
   Duration  4.76s (environment 97%, transform 2%, tests 1%, import 1%)


```

## point2-before.txt

Befehl: `gegen 338a2ee: npx vitest run tests/mainOutIsolation.test.ts`

```text

 RUN  v5.0.5 /workspace/work/round2-a4

 ❯ tests/mainOutIsolation.test.ts (3 tests | 1 failed) 286ms
   ❯ A4 mocked studio, studio, audio-output and visual-output peers (3)
     × initiates URL listeners for either socket ordering with a receive media section 82ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/mainOutIsolation.test.ts > A4 mocked studio, studio, audio-output and visual-output peers > initiates URL listeners for either socket ordering with a receive media section
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ tests/mainOutIsolation.test.ts:71:37
     69|     window.history.replaceState({}, '', '/master-out');
     70|     socket.id = 'z-listener';
     71|     expect(manager.isMasterOutMode).toBe(true);
       |                                     ^
     72|     await manager.connectToPeer('0-owner');
     73|     const peer = (manager as any).peerConnections.get('0-owner') as Pe…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
   Start at  10:00:51
   Duration  12.23s (environment 79%, transform 16%, tests 3%, import 2%)


```

## point2-errors-before.txt

Befehl: `MasterOutPage aus 338a2ee: npx vitest run tests/masterOutErrors.test.tsx`

```text

 RUN  v5.0.5 /workspace/work/round2-a4

 ❯ tests/masterOutErrors.test.tsx (1 test | 1 failed) 593ms
   × renders a connection failure instead of silently waiting for audio 572ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/masterOutErrors.test.tsx > renders a connection failure instead of silently waiting for audio
AssertionError: expected 'MASTER OUTMAIN SIGNALVerbinde mit Stu…' to contain 'Verbindung zum Studio fehlgeschlagen.'

Expected: "Verbindung zum Studio fehlgeschlagen."
Received: "MASTER OUTMAIN SIGNALVerbinde mit Studio-Session …Main-Ausgabe aktivierenMASTEROUTMAINSTREAM · /master-out · 4 iPads + 1 Laptop (PA)"

 ❯ tests/masterOutErrors.test.tsx:16:27
     14|   const div = document.createElement('div'); const root = createRoot(d…
     15|   await act(async () => root.render(<MasterOutPage />));
     16|   expect(div.textContent).toContain('Verbindung zum Studio fehlgeschla…
       |                           ^
     17|   expect(div.textContent).toContain('Verbindungsfehler');
     18|   await act(async () => root.unmount());

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  10:02:58
   Duration  14.81s (environment 76%, import 11%, transform 7%, tests 5%, setup 1%)


```

## point2-errors-after.txt

Befehl: `npx vitest run tests/masterOutErrors.test.tsx`

```text

 RUN  v5.0.5 /workspace/work/round2-a4


 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  10:03:22
   Duration  12.57s (environment 69%, import 17%, transform 8%, tests 5%, setup 1%)


```

## point4-before.txt

Befehl: `vor Punkt4: npx vitest run tests/httpMasterIsolation.test.tsx`

```text

 RUN  v5.0.5 /workspace/work/round2-a4

stderr | tests/httpMasterIsolation.test.tsx > A4 HTTP master receiver > never creates a receiver in a studio browser
Legacy-HTTP-Signaling übersprungen (socket.io übernimmt; VITE_SIGNALING_HTTP_URL nicht gesetzt).

stderr | tests/httpMasterIsolation.test.tsx > A4 HTTP master receiver > plays only at master-out and rejects a delayed track after navigation to studio
Legacy-HTTP-Signaling übersprungen (socket.io übernimmt; VITE_SIGNALING_HTTP_URL nicht gesetzt).

stdout | tests/httpMasterIsolation.test.tsx > A4 HTTP master receiver > plays only at master-out and rejects a delayed track after navigation to studio
High-Res Master Audio Stream connected to Tone.js Graph
High-Res Master Audio Stream connected to Tone.js Graph

 ❯ tests/httpMasterIsolation.test.tsx (2 tests | 2 failed) 34ms
   ❯ A4 HTTP master receiver (2)
     × never creates a receiver in a studio browser 28ms
     × plays only at master-out and rejects a delayed track after navigation to studio 4ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/httpMasterIsolation.test.tsx > A4 HTTP master receiver > never creates a receiver in a studio browser
AssertionError: expected 1 to be +0 // Object.is equality

- Expected
+ Received

- 0
+ 1

 ❯ tests/httpMasterIsolation.test.tsx:38:30
     36|     const before = mocks.pcs.length;
     37|     const root = await mountAt('/');
     38|     expect(mocks.pcs.length).toBe(before);
       |                              ^
     39|     await act(async () => root.unmount());
     40|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  tests/httpMasterIsolation.test.tsx > A4 HTTP master receiver > plays only at master-out and rejects a delayed track after navigation to studio
AssertionError: expected "vi.fn()" to be called 1 times, but got 2 times
 ❯ tests/httpMasterIsolation.test.tsx:49:27
     47|     window.history.replaceState({}, '', '/');
     48|     pc.ontrack({ streams: [{}] });
     49|     expect(mocks.connect).toHaveBeenCalledTimes(1);
       |                           ^
     50|     await act(async () => root.unmount());
     51|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  1 failed (1)
      Tests  2 failed (2)
   Start at  10:01:46
   Duration  1.18s (environment 77%, transform 11%, import 7%, tests 3%, setup 1%)


```

## point4-after.txt

Befehl: `nach Punkt4: npx vitest run tests/httpMasterIsolation.test.tsx tests/mainOutIsolation.test.ts`

```text

 RUN  v5.0.5 /workspace/work/round2-a4


 Test Files  2 passed (2)
      Tests  5 passed (5)
   Start at  10:02:06
   Duration  20.24s (environment 89%, import 5%, transform 3%, tests 3%)

    Isolate  2 workers spawned · ~8.90s startup each (spawn + environment, per file)
             at least ~8.90s faster with isolate: false — reuses workers across files instead of one per file


```

## relevant-final.txt

Befehl: `npx vitest run tests/mainOutIsolation.test.ts tests/httpMasterIsolation.test.tsx tests/masterOutErrors.test.tsx tests/webrtcManager.test.ts tests/listenerMode.test.ts tests/sessionCapacity.test.ts tests/sessionEndpoints.test.ts tests/sessionLockTransfer.test.ts tests/sessionRuntimeLocks.test.ts tests/lockStore.test.ts tests/authoritativeSession.test.ts tests/sessionSocketAccess.integration.test.ts tests/sfuSignaling.test.ts tests/sfuTicketHandshake.integration.test.ts`

```text

 RUN  v5.0.5 /workspace/work/round2-a4


 Test Files  14 passed (14)
      Tests  138 passed (138)
   Start at  10:04:04
   Duration  9.35s (environment 55%, tests 19%, import 14%, transform 9%, setup 1%, worker 1%)

    Isolate  14 workers spawned · ~418ms startup each (spawn + environment, per file)
             at least ~5.43s faster with isolate: false — reuses workers across files instead of one per file


```

## verify.txt

Befehl: `npm run verify`

```text

> audioMONASTRY@1.210.001 verify
> npm run typecheck && npm run lint && npm run test && npm run test:python && npm run security && npm run audio:gate && npm run audit:rt:gate && npm run test:rls && npm run check:deadfiles && npm run audit:deep:static && npm run verify:summary


> audioMONASTRY@1.210.001 typecheck
> tsc --noEmit


> audioMONASTRY@1.210.001 lint
> eslint . --max-warnings=0


/workspace/work/round2-a4/src/components/spatial/SpatialClubSetup.tsx
  97:35  warning  'i' is defined but never used. Allowed unused args must match /^_/u  @typescript-eslint/no-unused-vars

✖ 1 problem (0 errors, 1 warning)

ESLint found too many warnings (maximum: 0).

```

## audit-rt.txt

Befehl: `npm run audit:rt:gate`

```text

> audioMONASTRY@1.210.001 audit:rt:gate
> tsx scripts/audit/rt-bench.ts --gate

audioMONASTRY · Echtzeit-Audit (V2-Live-Pfad)

OK    RT-AUDIT-P0-001            Kick-Step hörbar (> -60 dBFS RMS)                     402.667 ms           SOLL >= 100 ms
OK    RT-AUDIT-P0-003/swing0     Swing 0: nicht gefeuerte Steps (V2StepQueue)                0 Steps        SOLL = 0
OK    RT-AUDIT-P0-003/swing0.5   Swing 0.5: nicht gefeuerte Steps (V2StepQueue)              0 Steps        SOLL = 0
OK    RT-AUDIT-P0-002/alloc      Neue Port-Puffer pro Block                                  0 Arrays/Block SOLL = 0
FAIL  RT-AUDIT-P0-002/gcmax      Längste GC-Pause (60 s)                                34.538 ms           SOLL < 1 ms
OK    RT-AUDIT-P0-002/gc         GC-Ereignisse pro Sekunde                                 0.1 1/s          SOLL < 0.2
FAIL  RT-AUDIT-P0-002/p999       Renderzeit p99,9                                       26.335 ms           SOLL < 1.33 ms (50 % Budget)
FAIL  RT-AUDIT-P0-002/over       Blöcke über Budget (2,67 ms)                              246 Blöcke       SOLL = 0
OK    RT-AUDIT-P0-002/noise      Descheduling-Ausreißer (Umgebung)                       0.098 % Blöcke     SOLL < 0.5 %
OK    RT-AUDIT-P0-004/-18        THD Masterkette bei -18 dBFS                                0 %            SOLL < 0,1 %
OK    RT-AUDIT-P0-004/-6         THD Masterkette bei -6 dBFS                                 0 %            SOLL < 0,5 %
OK    RT-AUDIT-P1-011            EffectNode: Energie rechts bei Impuls links                 0              SOLL < 1e-9
OK    RT-AUDIT-P1-009            Sample-Resampling SINAD (5 kHz, 44,1→48 kHz)           68.099 dB           SOLL >= 60 dB
OK    DSP-P1-OVS-001/alias1x     Saettiger-Aliasing 1x (vorher, Referenz)              -24.599 dB           SOLL Bericht (kein Gate)
OK    DSP-P1-OVS-001/alias2x     Saettiger-Aliasing 2x (Default, 0,4·Fs)               -47.372 dB           SOLL <= -40 dB
OK    DSP-P1-OVS-001/gain2x      Aliasing-Gewinn 2x gegenueber 1x                       22.773 dB           SOLL >= 15 dB
OK    DSP-P1-OVS-001/alias4x     Saettiger-Aliasing 4x (0,4·Fs)                        -86.175 dB           SOLL <= -70 dB
OK    DSP-P1-OVS-001/latency     Zusatzlatenz 2x (PDC-ausgeglichen)                          3 Samples      SOLL <= 4 und PDC = gemeldet
OK    DSP-P1-OVS-001/alloc       4x-Saettiger: neue Port-Puffer pro Block                    0 Arrays/Block SOLL = 0
OK    DSP-P1-OVS-001/cpu4x       4x-Saettiger: Mehrkosten ggü. 1x (Median)               2.897 % Budget     SOLL < 15 %

17/20 Grenzen eingehalten.

```

## Abschließende Checks

`npx tsc --noEmit`: Exit 0, keine Ausgabe.

`npx eslint src/utils/WebRTCManager.ts src/App.tsx src/pages/MasterOutPage.tsx src/pages/VisualOutPage.tsx src/context/AudioContext.tsx tests/mainOutIsolation.test.ts tests/masterOutErrors.test.tsx tests/httpMasterIsolation.test.tsx tests/webrtcManager.test.ts --max-warnings=0`: Exit 0, keine Ausgabe.

## A4.2 Follow-up

Datum: `2026-11-13T09:31:30Z` (`date -u +%FT%TZ`), gleicher Node22-PATH/Arbeitsverzeichnis.

Befehl: `Gegen 744bd7e: npx vitest run tests/masterOutErrors.test.tsx tests/mainOutIsolation.test.ts`

```text

 RUN  v5.0.5 /workspace/work/round2-a4

 ❯ tests/masterOutErrors.test.tsx (2 tests | 1 failed) 55ms
   × clears the old error only after received audio starts playing successfully 16ms
stderr | tests/mainOutIsolation.test.ts > A4 mocked studio, studio, audio-output and visual-output peers > clears cached connection errors only for a valid owner audio stream
Signaling connection failed: offline

 ❯ tests/mainOutIsolation.test.ts (6 tests | 1 failed) 38ms
   ❯ A4 mocked studio, studio, audio-output and visual-output peers (6)
     × clears cached connection errors only for a valid owner audio stream 13ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/mainOutIsolation.test.ts > A4 mocked studio, studio, audio-output and visual-output peers > clears cached connection errors only for a valid owner audio stream
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times

Received:

  1st vi.fn() call:

    Array [
      "Verbindung zum Studio fehlgeschlagen.",
    ]


Number of calls: 1

 ❯ tests/mainOutIsolation.test.ts:79:28
     77|     peers.get('b-studio')!.ontrack!({ streams: [new Stream([audio])], …
     78|     const afterValid = vi.fn(); const offValid = manager.onConnectionE…
     79|     expect(afterValid).not.toHaveBeenCalled(); offValid();
       |                            ^
     80|   });
     81|   it('initiates URL listeners for either socket ordering with a receiv…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  tests/masterOutErrors.test.tsx > clears the old error only after received audio starts playing successfully
AssertionError: expected 'MASTER OUTMAIN SIGNALMAIN LIVE – Ausg…' not to contain 'Verbindung zum Studio fehlgeschlagen.'

Expected: "Verbindung zum Studio fehlgeschlagen."
Received: "MASTER OUTMAIN SIGNALMAIN LIVE – Ausgabe läuftMain-Ausgabe aktivierenVerbindung zum Studio fehlgeschlagen.MASTEROUTMAINSTREAM · /master-out · 4 iPads + 1 Laptop (PA)"

 ❯ tests/masterOutErrors.test.tsx:29:31
     27|   });
     28|   expect(div.textContent).toContain('MAIN LIVE');
     29|   expect(div.textContent).not.toContain('Verbindung zum Studio fehlges…
       |                               ^
     30|   await act(async () => root.unmount());
     31|   play.mockRestore();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  2 failed (2)
      Tests  2 failed | 6 passed (8)
   Start at  10:30:29
   Duration  3.01s (environment 81%, import 8%, transform 7%, tests 3%)

    Isolate  2 workers spawned · ~1.22s startup each (spawn + environment, per file)
             at least ~1.22s faster with isolate: false — reuses workers across files instead of one per file


```

Befehl: `npx vitest run tests/masterOutErrors.test.tsx tests/mainOutIsolation.test.ts tests/httpMasterIsolation.test.tsx tests/webrtcManager.test.ts`

```text

 RUN  v5.0.5 /workspace/work/round2-a4


 Test Files  4 passed (4)
      Tests  29 passed (29)
   Start at  10:31:05
   Duration  4.31s (environment 80%, import 10%, transform 6%, tests 4%)

    Isolate  4 workers spawned · ~879ms startup each (spawn + environment, per file)
             at least ~2.64s faster with isolate: false — reuses workers across files instead of one per file


```

`npx tsc --noEmit`: Exit 0, keine Ausgabe.

`npx eslint src/utils/WebRTCManager.ts src/pages/MasterOutPage.tsx tests/mainOutIsolation.test.ts tests/masterOutErrors.test.tsx --max-warnings=0`: Exit 0, keine Ausgabe.

RT-Gate ausdrücklich nicht wiederholt; zuvor dokumentierte 17/20 unverändert.

## A4 Testvertrag Opus/SFU (2026-11-13T10:10:04Z)

Nur bestehender Testvertrag angepasst, kein Produktionscode geändert. Der frühere Test verlangte zweimal ungerichtetes Main-SFU-Publishing. Die Voice-Klassifikation (zweimal voice) und sechs Opus-SDP-Aufrufe bleiben unverändert geprüft; Main-Music-SFU-Publishing wird jetzt ausgeschlossen. Der positive Verhaltensnachweis für Main am attestierten P2P-Output bleibt in mainOutIsolation.test.ts erhalten. Keine Assertions entfernt, keine Either-or-Erlaubnis, kein DSP-/RT-Neulauf.

Befehl: `Vorher: npx vitest run tests/opusMusicSdp.test.ts`

```text

 RUN  v5.0.5 /workspace/work/round2-a4

 ❯ tests/opusMusicSdp.test.ts (7 tests | 1 failed) 142ms
   ❯ RT-AUDIT-P1-013 · SFU-Producer (2)
     × Mikrofon-Spuren im WebRTCManager laufen als "voice", Main-Spuren als "music" 5ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/opusMusicSdp.test.ts > RT-AUDIT-P1-013 · SFU-Producer > Mikrofon-Spuren im WebRTCManager laufen als "voice", Main-Spuren als "music"
AssertionError: expected undefined to be 2 // Object.is equality

- Expected:
2

+ Received:
undefined

 ❯ tests/opusMusicSdp.test.ts:91:68
     89|     const src = readFileSync(path.resolve(__dirname, '../src/utils/Web…
     90|     expect(src.match(/sendAudioTrack\(track, 'voice'\)/g)?.length).toB…
     91|     expect(src.match(/sendAudioTrack\(track, 'music'\)/g)?.length).toB…
       |                                                                    ^
     92|     expect(src.match(/withMusicOpus\(/g)?.length).toBe(6);
     93|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
   Start at  11:09:53
   Duration  313ms (tests 70%, transform 21%, import 4%, setup 3%, worker 2%)


```

Befehl: `Nachher: npx vitest run tests/opusMusicSdp.test.ts tests/mainOutIsolation.test.ts tests/webrtcManager.test.ts`

```text

 RUN  v5.0.5 /workspace/work/round2-a4


 Test Files  3 passed (3)
      Tests  32 passed (32)
   Start at  11:10:02
   Duration  2.15s (environment 81%, tests 10%, transform 4%, import 4%, worker 1%, setup 1%)

    Isolate  3 workers spawned · ~595ms startup each (spawn + environment, per file)
             at least ~1.19s faster with isolate: false — reuses workers across files instead of one per file


```
