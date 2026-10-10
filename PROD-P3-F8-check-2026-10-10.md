# PROD-P3-F8 Check 2026-10-10

## Gates
- `npm run typecheck` → 0 Fehler (exit 0)
- `npm test` → 335 Testdateien, 2758 Tests grün
- `npm run verify:boundary` → Keine direkten Plattform-API-Zugriffe in Kernmodulen

## Code-Review
- `server/routes/sessionRoutes.ts` implementiert:
  - Zwei Schlösser für `/api/session/reset`: `NODE_ENV !== 'production'` UND `AUDIOMONASTRY_TEST_RESET=1`, sonst 404
  - Token-Pflicht wenn Studio-Token konfiguriert
  - Reset tauscht Session, stoppt Save-Timer, persistiert sofort, liest neuen Zustand zurück, neue `sessionInstanceId`
  - `GET /api/session/state` mit derselben Schranke
  - `/api/session/autosave` mit begrenztem Retry und einmaliger Warnung je Fehlerklasse
- `server/socketLiveness.ts`:
  - `online`-Messwert aus Socket-Registry, nicht Zähler
  - Liveness-Map pro Socket, `evaluateSocketLiveness` rein, Sweep intervallgetrieben, Geister-Entfernung, Idle-Disconnect mit `forceRetryMs`
- Tests:
  - `tests/socketLiveness.test.ts` 8/8 grün
  - `tests/sessionResetRoutes.test.ts` + `tests/sessionResetProduction.test.ts` 11/11 grün

## Acceptance
Ticket-Master-Eintrag:
- status: PARTIAL
- note: Code DONE 2026-09-20, gemergt 12d2273
- verification: tsc 0, 36 Tests grün, Live-Test gegen echte Socket.io Clients 0→2→1 nach hartem Abbruch, Reset 200 mit neuer Instanz-ID
- live_open: TCP-Abriss ohne Close-Paket real (Paketverwerfen) – bisher nur via Stubs/Hub-Test belegt

## Ergebnis
Gates grün, Code-Acceptance erfüllt. Ticket bleibt **PARTIAL** wegen offenem live_open „TCP-Abriss ohne Close-Paket real (Paketverwerfen)“. Kein Commit nötig.
