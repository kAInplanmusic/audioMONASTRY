# SFU admission hardening (DAW-Breaker DB-005)

**Status:** proposed on a draft PR; not deployed. `main` is unchanged.

## Threat model
The WebRTC signaling service on `SFU_SIGNALING_PATH` is a separate Socket.IO
server and therefore does **not** inherit the primary studio signaling auth.
Historically anybody able to reach that endpoint could request router and
transport creation. The CORS setting does not authenticate Socket.IO clients.

## Protocol
1. The browser authenticates with the **studio app origin** using its existing
   HttpOnly `studio` cookie, then requests
   `GET /api/sfu-ticket?sessionId=<id>`.
2. The app's existing `/api` authentication checks that request. If
   `SESSION_SECRET` is configured, the app signs an HMAC-SHA256 ticket:
   `v1.<expiresUnix>.sfu_<sessionId>.<signature>`. The response sets
   `Cache-Control: no-store`. TTL: 90 seconds.
3. At **every** connection/reconnection, the browser obtains a fresh ticket via
   same-origin fetch and supplies it using Socket.IO's `auth.token` field.
   The master token and HttpOnly cookie never go to the separate SFU host.
4. The SFU uses its own `sfuIo.use(...)` middleware to reject invalid or
   missing tokens *before* accepting the connection or allocating a router.
   Signature, expiration and the requested SFU `sessionId` are checked.
5. If the API fetch fails, the browser submits an empty ticket, which the SFU
   rejects. If `SESSION_SECRET` is absent, the API returns HTTP 503 and the
   SFU rejects all handshakes.

## Deployment prerequisites
- Configure the **same independently generated strong** `SESSION_SECRET`
  on the studio API host and the SFU host. Never send the secret to the browser.
- Both processes must have synchronized system clocks.
- Ensure `SIGNALING_ALLOWED_ORIGINS` lists the studio page origins in use.
- Deploy app/backend issuance and the browser client before/enough together
  with the SFU middleware; mismatched versions break SFU joins.
- Rotate previously exposed keys and verify secret availability via secure
  operations channels. Do not add credentials to repository files.
- Avoid caching `/api/sfu-ticket` in reverse proxies; protect TLS end-to-end.

## Scope and limitations
- **Solved in code:** anonymous SFU admission, absent/expired ticket, incorrect
  session ID; browser ticket refresh on reconnect.
- **Additional fixes:** the SFU router advertises VP8 video capability in
  addition to stereo Opus, and relays JSON-serializable `data` events only
  within the sender's authenticated SFU session (64 KiB / 100 events per
  second per connected socket).
- **Not solved:** binding a specific user to a signed identity; restricting one
  studio identity to one SFU connection; revoking currently connected peers
  before disconnect; the four-user capacity across multiple processes;
  cross-node SFU room broadcasting.
- A ticket issued to a studio-authenticated client is reusable for 90 seconds.
  Use server-side nonce/replay protection if one-use semantics are required.
- A local Socket.IO integration test now exercises anonymous, mismatched,
  valid admission, isolated relay and VP8 codec setup with a mocked mediasoup
  worker. Full **real mediasoup RTP**, 4-user concurrency and browser audio
  verification are still required before production release.

## Local tests (offline)
```bash
npx vitest run tests/sfuTicket.test.ts tests/sfuSignaling.test.ts tests/sfuTicketHandshake.integration.test.ts
npm run typecheck
npm run lint
```
