> ⚠️ SUPERSEDED (2026-09-11): Einzige SSOT fuer offene Arbeiten ist jetzt **MASTERTODOENDE.json**.
> Dieses Dokument bleibt nur als historische Referenz und wird nicht mehr gepflegt.

# MASTERTODO — audioMONASTRY Produktionsreife (P0–P2)

> Stand: 2026-09-09 · Arbeitsliste für die DeepCode-Prompt-Umsetzung.
> Regel: V1-Punkte sind VERIFIKATIONSPUNKTE (V1 ist im Ruhestand), keine offenen Arbeiten.
> Status: [x] erledigt · [>] in Arbeit · [ ] offen · [~] teilweise / BLOCKED

## P0

### P0-1 · Produktionssichere Authentifizierung und Autorisierung
- [x] Fail-closed: ohne `STUDIO_ACCESS_TOKEN` und ohne expliziten Dev-/Test-Modus ist die API geschlossen (503 `STUDIO_TOKEN_MISSING`).
- [x] Expliziter Dev-Modus nur via `AUDIOMONASTRY_DEV_NO_AUTH=1` (in Production wirkungslos).
- [x] Origin-Allowlist für `/api` in Production (`API_ALLOWED_ORIGINS`/`SIGNALING_ALLOWED_ORIGINS`).
- [x] Socket.io-Handshake: gleiches Auth-Modell (Token/Origin/fail-closed).
- [x] MCP-Permission-Test (READ auf WRITE-Tool → permission denied).
- [x] Tests: `tests/securityAuthz.test.ts` (12 Tests) + bestehende `securityProductionAuth`/`security`.
- [~] Rollen-/Session-Autorisierung pro Aktion (Guest→PRO, Cross-Session): Teil von P0-2, dort umsetzen.
- [ ] Cookie-Sicherheit serverseitig dokumentieren (Cookie setzt der Portal-Worker; HttpOnly/Secure/SameSite dort) — in `.env.example` dokumentiert.

### P0-2 · Serverautoritative 4-User-Kollaboration
- [ ] Serverautoritative Session-State-Struktur (Revision/Sequence, Sender, Timestamp, idempotente Event-ID).
- [ ] Vollständiger Snapshot für neue/reconnectete Clients.
- [ ] Deterministisches Verwerfen veralteter/doppelter Events.
- [ ] Konfliktauflösung: Plugin-State, BPM, Transport, Routing, Rollen.
- [ ] Locks atomar serverseitig (vergeben/verlängern/freigeben; Disconnect/Timeout/Reconnect).
- [ ] Redis-Multi-Instanz: Rollen/Locks/State nicht nur in lokalen Maps.
- [ ] Host-/Admin-Bestimmung deterministisch (nicht Socket-Reihenfolge).
- [ ] Tests: 4 parallele User, Lock-Denial/Rollback, Disconnect/Reconnect, verspätete DataChannel-Nachricht, Server-Neustart, 2 Instanzen mit Redis.

### P0-3 · WebRTC/SFU-Zuverlässigkeit + TURN
- [ ] ICE-Server aus sicherer Server-Konfiguration laden (keine hardcodierten Annahmen).
- [ ] Kurzlebige TURN-Credentials statt statischer Secrets im Frontend.
- [ ] `iceConnectionState`/`connectionState`/`signalingState` explizit behandeln.
- [ ] Kontrollierte Reconnects mit Backoff; keine doppelten PeerConnections/Tracks.
- [ ] Fallback-Strategie: P2P → SFU → sichtbarer Fehler mit Retry.
- [ ] Mikrofon-verweigert-Zustand ohne Dauer-Hänger.
- [ ] Tests: ICE-Fehler, Reconnect, TURN-Konfiguration, Main-Stream-Wiederherstellung.

### P0-4 · Audio-Stabilität, Latenz, Ressourcen-Lifecycle
- [ ] Audio-Thread-kritische Stellen: Allokationen, synchrones Logging, doppelte Node-Erzeugung.
- [ ] Zuverlässiges Dispose: AudioNodes, Player, Worklets, AudioBuffers, Preview-Player.
- [ ] Keine doppelten Master-Ausgänge/Verbindungen nach Reconnect/Reload.
- [ ] AudioContext-Suspend/Resume + User-Gesture (Safari/iOS).
- [ ] Telemetrie: Xruns, Worklet-Fehler, Context-State, baseLatency/outputLatency, Sample-Rate, Graph-/Node-Anzahl.
- [ ] Audio-Gates: 60 s Idle RMS ≤ -60 dBFS; 120 BPM/10 min ohne Step-/Jitter-Fehler; keine Dropouts/Zipper.
- [ ] Regressionstests mit Golden-Audio-Referenzen.

### P0-5 · V1-Verifikationspunkte (nicht mehr offen)
- [x] Tone.js entfernt (`nativeAudioKit` ersetzt alle Tone-Imports; `tone` nicht mehr in package.json).
- [x] V1-Feature-Flags entfernt (`resolvePlaybackMode` erzwingt 'v2').
- [x] GraphEngineAdapter entfernt.
- [x] V2-Live-Gate headed grün ohne Tone (11,9 s).

## P1

- [ ] P1-1: Robuste lokale/entfernte Persistenz (versioniertes Snapshot-Schema, debounced Autosave, OPFS/IndexedDB-Puffer, Retry/Backoff Supabase/R2, Idempotenz).
- [ ] P1-2: API-Typisierung/Validierung/Fehlerverträge (Zod statt `req.body as`, einheitliches Fehlerformat, route-spezifische Limits, SSRF-Schutz, AbortController/Timeouts, server.ts schrittweise zerlegen).
- [ ] P1-3: AI-Provider-Zuverlässigkeit/Kostenkontrolle/RunPod (Timeouts/Retries/Cancellation, Circuit-Breaker, Idempotency Keys, Kostenlimits, Job-Status-Persistenz, deterministische Modell-Pins).
- [ ] P1-4: Mobile UX/Accessibility/Audio-Permissions (44 px Touch-Ziele, Safe-Area, keine Hover-only-Funktionen, sichtbare Zustände, Keyboard/Focus/Screenreader, prefers-reduced-motion, Hotkeys nicht in Eingabefeldern, mobile Playwright-Konfiguration).
- [ ] P1-5: Verlässliche Release-Gates/CI (ein reproduzierbarer Gate-Befehl, CI mit E2E, Artefakte, Dependency-/Secret-Scans, Versions-Sync, keine `latest`-Actions, E2E nicht überspringbar).

## P2

- [ ] P2-1: Single Source of Truth für Plugins/Architektur/Observability (Konsistenztest Registry↔Manifest↔App↔Docs, Request-/Session-/Job-IDs, rate-limitierte Telemetrie, Histogramme, Live-Checkliste).
- [ ] P2-2: server.ts-Zerlegung (Dependency-Graph zuerst, dann Router/Services, keine Verhaltensänderung).
- [ ] P2-3: Dead Code/Doku/Versions-Drift (README 1.10.1 vs package.json 1.210.001).

## Abnahmekriterien (global)

- [x] `npm run verify` grün (Bestandteil der Paket-Abnahme).
- [x] `npm run build` grün.
- [x] `npm run lint` grün.
- [ ] Neue Tests für Sicherheit, Reconnect, Persistenz, Audio, 4-User (fortlaufend je Paket).
- [x] Keine Secrets im Client/Bundle (VITE_-Regel; wird je Paket geprüft).
- [x] Keine direkte Plattform-API außerhalb der Adapter (Boundary-Scan grün).
- [x] App bleibt im Idle still (Audio-Gate-Teil von P0-4).
- [ ] Keine Regression bei Main-Stream, Monitor-Cue, Plugin-Locking, Rollenmodell (je Paket testen).
- [ ] Keine ungetestete Änderung an Providern/RunPod/Supabase/R2/TURN/SFU als erfolgreich markieren.

## Berichtsformat (nach jedem Paket)

- geänderte Dateien
- Architekturentscheidungen
- ausgeführte Befehle
- Testergebnisse
- offene Punkte
- nächste Schritte
