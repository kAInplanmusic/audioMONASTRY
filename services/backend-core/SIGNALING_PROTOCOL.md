# Signaling Protocol (audioMONASTRY)

Das Signaling-Protokoll definiert die Kommunikation zwischen Clients und dem Signaling-Server zur Etablierung von WebRTC-Verbindungen und zur Synchronisation des Anwendungszustands (Locking).

## 1. Nachrichten-Struktur
Alle Nachrichten sind JSON-objekte:
```json
{
  "type": "string",
  "sender": "userId",
  "recipient": "userId",
  "payload": { ... }
}
```

## 2. Typen

### A. WebRTC-Verbindungsaufbau (Full-Mesh)
- `init`: Registrierung der UserID am Server.
- `sdp_offer`: Senden eines SDP-Offers an einen spezifischen User.
- `sdp_answer`: Senden eines SDP-Answers an einen spezifischen User.
- `ice_candidate`: Austausch von ICE-Candidates.

### B. Kollaborations-Layer (DataChannel-Locking)
- `lock_request`: User möchte ein Modul sperren.
  `payload: { moduleId: "string" }`
- `lock_status`: Server broadcastet den aktuellen Sperrstatus eines Moduls.
  `payload: { moduleId: "string", userId: "string", status: "locked" | "unlocked" }`
