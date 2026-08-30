# audioMONASTRY – Security-Remediation-Plan („gesamt grün")

> Basis: Security- & Code-Review vom 2026-08-30 (Commit `b4bf4a1`) + eigener
> Abgleich gegen den Code. Ziel: **alle 16 Server-Befunde + F1–F7 + Rust-F9
> beheben**, Tests ergänzen, Re-Audit grün, CI grün.

**Kernarchitektur-Entscheidung (behebt 1, 3, 5, 9, 11, 12 gemeinsam):**
Das Portal (Cloudflare Worker) ist bereits die einzige Tür. Es erhält beim
Flottenstart ein **Studio-Token**-Konzept:

```
Worker (Login, HMAC-Session)
   │  1. generiert STUDIO_ACCESS_TOKEN (random, 32 Byte)
   │  2. injiziert es in app-1 .env (cloud-init)
   │  3. setzt HttpOnly-Cookie `studio=<token>` auf anunnakitools.de
   │  4. proxyt nur Requests mit gültigem Cookie an den Origin
   ▼
app-1 (Express-Middleware `requireStudioToken`)
   · alle /api/* (außer /api/health) + Socket.io-Handshake prüfen Token
   · teure Endpunkte zusätzlich mit engem Rate-Limit pro Token
```

Damit sind unauthentifizierte API-Calls, fremde Socket-Verbindungen, offene
Metriken und R2-/Supabase-Schreibzugriffe gemeinsam geschlossen.

---

## Phase 0 – Sofort (Portal-Kritikal + Quick Wins, ~½ Tag)

| ID | Befund | Maßnahme | Dateien | Test |
|---|---|---|---|---|
| P-3 | Leeres Admin-Passwort = Zugang | `ADMIN_PASSWORD`/`SESSION_SECRET` als Pflicht: beim Worker-Start (und im Code) hart ablehnen, wenn leer oder `change-me`. Login mit konstantzeitlichem Vergleich (WebCrypto/`subtle`-Vergleich oder manuell XOR über Bytes). | `services/portal-worker/src/index.js` | Unit-Test Login leer/falsch; `wrangler deploy --dry-run` |
| P-13 | Idempotenz-Status immer `failed` | Mapping korrigieren: `resp.ok ? 'success' : 'failed'`; Status im Job-Map ablegen. | `server.ts` (~660) | Vitest: Erfolg setzt `success` |
| P-14 | Idempotenz-Key 60 s gesperrt | Sperre nur solange der Job **aktiv** ist; nach Abschluss sofort löschen (oder 5 s Grace). Retry nach Fehlschlag sofort erlaubt. | `server.ts` (~625) | Vitest: Retry nach `failed` funktioniert |
| P-F3 | `JSON.parse` ohne try/catch im Peer-Kanal | try/catch + Schema-Check (`WebRTCMessage`-Discriminator, Pflichtfelder) vor Verarbeitung. | `src/utils/WebRTCManager.ts:288` | Vitest: kaputter Frame wirft nicht |
| P-F2 | `onDataChannelMessage` ist Single-Slot | Auf Listener-Set umbauen (Muster `addStepListener`): `addDataChannelListener(cb)`, alle drei Verbraucher (`useSessionSync`, `ModuleStateContext`, `adapters.ts`) migrieren, Rückwärts-Slot für Alt-Code behalten. | `src/utils/WebRTCManager.ts`, 3 Consumer | Vitest: mehrere Listener erhalten dieselbe Nachricht |
| P-F5 | `senderId: 'localUser'` hartkodiert | `webRTCManager.userId` verwenden; Server-`senderUserId` beim Empfang übernehmen. | `src/context/ModuleStateContext.tsx` | Vitest: gesendete ID = `userId` |
| P-F6 | NaN durch Gain-Klemmung | `Number.isFinite`-Guards in `setChannelEQ` und `setChannelGain` (NaN→Default 0 bzw. 1). | `src/utils/audioEngine.ts:744,761` | Vitest: `NaN` wird geclampt |
| P-F7 | SDP in localStorage | Persistenz entfernen (kein localStorage für `webrtcLocalDescription`/`remote`). | `src/context/AudioContext.tsx:233` | Vitest/manuell: kein localStorage-Eintrag |
| P-F9 | Committete Rust-Binary | `services/mixer/*.node` löschen + `.gitignore` ergänzen; Build nur über `Dockerfile.multistage`/`cargo`. | `services/mixer/`, `.gitignore` | Repo-Check: keine `*.node` |

---

## Phase 1 – Zugangskontrolle & Rate-Limit (Kern, ~1–2 Tage)

| ID | Maßnahme | Dateien |
|---|---|---|
| P-1 | `requireStudioToken`-Middleware: Header `x-studio-token` ODER Cookie `studio`; HMAC- oder fester Vergleich gegen `STUDIO_ACCESS_TOKEN` (env). `/api/health` bleibt offen (Loadbalancer/Monitoring), alles andere `/api/*` geschützt. Worker setzt Cookie + Forward. | `server.ts`, `services/portal-worker/src/index.js` |
| P-5 | `app.set('trust proxy', 1)` nur wenn `TRUST_PROXY=1`; Rate-Limit je Route (health 120/min, AI 10/min, Upload 5/min, Telemetrie 60/min, Rest 60/min); `keyGenerator` = Studio-Token (Fallback IP); bei `REDIS_URL` optional `rate-limit-redis`. | `server.ts` |
| P-9 | `/api/metrics` hinter Studio-Token (oder `127.0.0.1` + Token). | `server.ts` |
| P-11 | Socket.io: `origin`-Allowlist aus `SIGNALING_ALLOWED_ORIGINS` (kein `*` im Produktiv-Deploy), Handshake-Auth gegen Studio-Token (`io.use`). Worker reicht Cookie/Token im Handshake durch. | `server.ts` (~1196), Portal-Worker |
| P-12 | R2-Key-Whitelist: `^uploads/[a-z0-9._-]+(?:/[a-z0-9._-]+)*$` (kein `..`, kein führender Slash, Länge ≤ 200), plus Auth. | `server.ts:375` |

**Tests:** Vitest-Suite `tests/security.test.ts`: ohne Token → 401/403 auf allen
geschützten Routen; mit Token → 200; Socket-Handshake ohne Token abgelehnt;
Rate-Limit greift; Key-Whitelist blockt `../`, `/etc`, Leerzeichen.

---

## Phase 2 – Upload-Härtung (OOM-DoS & Parser, ~1 Tag)

| ID | Maßnahme | Dateien |
|---|---|---|
| P-2 | Streaming-Größen-Limit **während** des Lesens: zentraler Guard (`limitRawBody(maxBytes)`) der bei Überschreitung `req.destroy()` + 413 sendet, bevor gepuffert wird. Max: Stems 100 MB, Upload 100 MB. `express.json`-Limit bleibt als zweite Schicht. | `server.ts:543,789` |
| P-8 | `busboy` (bewährter Multipart-Parser, streamt) statt handgeschriebenem `latin1`-Regex-Parser; Boundary-Erkennung und Datei-Felder korrekt; Größen-Limit je Part. | `server.ts:757`, `package.json` (+`busboy`) |

**Tests:** Vitest: Upload mit >Limit → 413 und Stream wird früh abgebrochen
(Mock-Request mit großem Body); Multipart mit quoted Boundary funktioniert.

---

## Phase 3 – Secrets & Transport (Portal→Server, ~1 Tag)

| ID | Maßnahme | Dateien |
|---|---|---|
| P-4 | Rollen-spezifische `.env`: cloud-init schreibt nur die Secrets, die die Rolle braucht (app: Supabase/R2/Replicate/AI; sfu: nichts davon; edge: nur Monitoring-Env; ai: nur Ollama/Stem-Env; master: nichts). `GITHUB_TOKEN` nie in `git clone`-URL einbetten, sondern als `GIT_ASKPASS`-Skript oder `Authorization`-Header-Clone (Header-URL `https://x-access-token:` gilt als Klartext in Prozessliste → stattdessen `git -c http.extraHeader="Authorization: Basic ..."` bzw. Askpass-Datei mit `chmod 600`). | `services/portal-worker/src/index.js` |
| P-7 | Cloudflare→Origin: (a) sofort Firewall des app-1 auf **Cloudflare-IP-Ranges** für 80/443 einschränken (Worker-IP-Liste aus `https://api.cloudflare.com/client/v4/ips`); (b) danach Origin-TLS mit Cloudflare Origin Certificate (Caddy) + Worker `https://`-Proxy (Full-Strict). | Portal-Worker, `scripts/hetzner/cloud-init`-Teil, `Caddyfile` |
| P-10 | Telemetrie-`ctx` auf 2 KB JSON kappen, `events`-Body-Limit 1 MB (Route-Middleware), Nachricht 1000 Zeichen (bleibt). | `server.ts:203` |
| P-16 | Security-Header ohne CSP-Bruch: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Permissions-Policy`; CSP vorsichtig in Phase 3b (Worklets/Blob/WebRTC berücksichtigen). | `server.ts` (Middleware) |

---

## Phase 4 – Daten & Python-Dienst (~½ Tag)

| ID | Maßnahme | Dateien |
|---|---|---|
| P-6 | `schema.sql` **nicht-destruktiv**: DROP-Anweisungen entfernen; `CREATE TABLE IF NOT EXISTS` + migrationsartige `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. Destruktiven Reset in `database/reset.sql` auslagern. | `database/schema.sql`, neu `database/reset.sql` |
| P-15 | stem-ai Ring-Puffer: älteste Session nur löschen, wenn älter als **30 min** (Grace für Downloads) ODER nie automatisch löschen + TTL-Cleanup-Job. | `services/stem-ai/main.py` |

---

## Phase 5 – Kollaboration härten (Frontend, ~1–2 Tage)

| ID | Maßnahme | Dateien |
|---|---|---|
| P-F1 | Empfangspfad prüft Rollen: in `ModuleStateContext` eingehende `PLUGIN_STATE_UPDATE` gegen `assertCan(role, 'plugin.control')` validieren (Rolle aus Server-`senderUserId`/Session-Host, nicht aus eigenem localStorage). Server relayt nur noch, wenn Sender = Session-Host für `PRO`-Promotions (Host = erster Joiner). Client-RBAC bleibt UX, wird als solche dokumentiert. | `src/context/ModuleStateContext.tsx`, `src/utils/rbac.ts`, `server.ts` (Relay) |
| P-F4 | `isTrustedMediaUrl()`-Utility: erlaubt `blob:`, `data:` (klein), `/music/`, `/api/…`, R2-Public-Base (env), `https://anunnakitools.de/*`; überall vor `fetch(url)`/`new Audio(url)` aus Peer-Daten. | neu `src/utils/mediaUrlGuard.ts`; Nutzung in `SampleContext.tsx`, `DrumMachineTerminal.tsx`, `SingingEngine.ts` |

**Tests:** Vitest für URL-Guard + Receive-RBAC (fremder `PRO`-State wird abgelehnt, eigener erlaubt).

---

## Phase 6 – Re-Audit & „gesamt grün"

1. `npm audit` (prod+dev) → 0.
2. `npx tsc --noEmit` sauber.
3. Vitest komplett grün (bestehende 199 + neue Security-Tests).
4. `node scripts/validate-interface-boundaries.mjs` → 0 Verstöße.
5. `npm run build` + `node scripts/check-bundle-size.mjs`.
6. E2E: smoke, collab, live2browser, keyboard, responsive (Chromium+Firefox).
7. `wrangler deploy --dry-run` Portal-Worker + Portal-Unit-Test (leeres Passwort abgelehnt).
8. Re-Audit-Dokument: alle 16 + F1–F7 + F9 als „behoben" oder „bewusst akzeptiert (mit Begründung)" markieren.

---

## Reihenfolge & Rollback

- **Erst Phase 0** (risikoarm, sofortiger Wert), dann **Phase 1** (Kern),
  dann **2 → 3 → 4 → 5**, Abschluss **Phase 6**.
- Jede Phase wird separat committet und gepusht; bei Regression: Commit-Revert
  pro Phase möglich (keine Phase baut auf ungetestetem Zustand der Vorphase auf).
- Verifikation nach jeder Phase: `tsc` + Vitest + gezielter E2E-Lauf.
