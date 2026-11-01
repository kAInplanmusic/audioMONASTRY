# Auth-System (DB-004, DB-005)

## Überblick

audioMONASTRY verwendet ein zweistufiges Authentifizierungssystem:

1. **Studio-Session-Tokens** (HTTP API & Socket.IO)
2. **SFU-Tickets** (Socket.IO-to-mediasoup Bridge)

## 1. Studio-Session-Tokens

### Flow

```
Client              Server               Purpose
 │                    │
 │ POST /api/auth/login
 │ username, password │
 ├───────────────────►│
 │                    │ validate credentials
 │ ◄──────────────────┤
 │                  { token, session }
 │ x-studio-token Cookie
 │                    │
 │ Socket.IO CONNECT
 │ x-studio-token     │
 ├───────────────────►│ verifyStudioSession()
 │ ◄──────────────────┤
 │                  authenticated
```

### Token-Format

`v1.<exp>.<sub>.<sig>`

- `v1` - Version
- `<exp>` - Expiry timestamp (Unix seconds)
- `<sub>` - Subject (username)
- `<sig>` - HMAC-SHA256 signature

### Test Accounts (DB-004)

| Username | Role | Password |
|----------|------|----------|
| dj | dj | dj |
| producer | producer | producer |
| engineer | engineer | engineer |
| admin | admin | admin |

## 2. SFU-Ticket-Auth (DB-005)

### Warum separate Tickets?

Der SFU (mediasoup) läuft auf einer anderen Domain/Origin als der App-Server. Socket.IO-Handshake kann nicht auf das HttpOnly-Cookie zurückgreifen.

### Flow

```
Client (Studio)     Server               SFU (Mediasoup)
 │                    │                      │
 │ Socket.IO Connect
 │ to sfu.domain      │                      │
 ├────────────────────┼─────────────────────►│
 │                    │ issueSfuTicket()    │
 │                    │ (via /api/media/sfu-ticket)
 │                    ◄────────────────────┤
 │                                          { ticket }
 │ SFU ticket in connect query
 │ (x-sfu-token)                           │
 ├────────────────────┼─────────────────────►│
 │ verifySfuTicket()   │                      │
 │ (signature + session binding)
 │                                          ◄───────
```

### Implementation

- **issueSfuTicket()**: Erstellt HMAC-ticket für exakt 1 SFU-Session (90s TTL)
- **verifySfuTicket()**: Validiert Ticket-Format, Signatur, Session-Binding
- **Validierung**: Token muss `v1.<exp>.<sfu_<id>>.<sig>` Format haben

### Wichtige Validierungen

1. SFU-Session-ID darf keine Punkte enthalten (`^[A-Za-z0-9_-]{1,64}$`)
2. SFU-Ticket akzeptiert KEINE Master-Tokens (nur speziell ausgestellte Tickets)
3. Ticket-Verfall nach 90 Sekunden

## API-Endpoints

### POST /api/auth/login

```json
// Request
{
  "username": "dj",
  "password": "dj"
}

// Response
{
  "ok": true,
  "token": "v1.1700000000.dj.ABC123...",
  "session": {
    "id": "sess_abc123...",
    "username": "dj",
    "role": "dj"
  }
}
```

### POST /api/media/sfu-ticket

Erstellt SFU-Ticket für aktuelle Studio-Session.

## Sicherheit

- **Branch-Protection**: Nicht implementiert (GitHub-UI erforderlich)
- **Secrets Rotation**: Nicht automatisierbar (GitHub-UI erforderlich)
- **.env-Dateien**: Im .gitignore, nie committen

## Tests

- `tests/authRoutes.test.ts` - Auth-Route-Tests (7 Tests)
- `tests/sfuTicket.test.ts` - SFU-Ticket-Tests (5 Tests)