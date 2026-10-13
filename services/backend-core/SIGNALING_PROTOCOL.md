# Signaling Protocol (audioMONASTRY)

Das Signaling-Protokoll definiert die Kommunikation zwischen Clients und dem Signaling-Server zur Etablierung von WebRTC-Verbindungen und zur Synchronisation des Anwendungszustands (Locking).

## 0. Transport-Entscheidung (verbindlich)

Dieses Dokument beschreibt das NACHRICHTEN-Protokoll und ist transportunabhaengig.
Verbindlich fuer den Betrieb ist genau EIN Transport (Deep-Audit DA-2026-09-29-038):

- **Aktiv (Deploy):** Socket.io im Hauptserver (`server.ts`) mit den Session- und
  Relay-Modulen unter `src/core/session/*` - dieselbe Nachrichtenmenge (init, sdp,
  ice, lock_request, lock_status). Medien laufen getrennt ueber den mediasoup-SFU
  (WebRTC), nicht ueber diesen Kanal.
- **Referenz (nicht deployt):** `services/backend-core/node/index.js` setzt dasselbe
  Protokoll auf rohem `ws` um. Es gibt keinen Compose-Service und keinen Startpfad
  fuer diesen Server; er ist lesbare Referenz und Gegenprobe des Protokolls, kein
  zweiter Produktionsweg. Deshalb deklariert `node/package.json` auch nur `ws`.

Grund: zwei halb beschriebene Transporte nebeneinander laden dazu ein, den falschen
weiterzubauen. Wer das Protokoll aendert, aendert es in `src/core/session/*` und
zieht die Referenz hier nach - nicht umgekehrt.

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

## 3. Sicherheitsregeln (verbindlich)

- **Identität:** `init.sender` muss serverseitig validiert werden (nicht leer,
  Whitelist-Zeichen, max. 128 Zeichen). Der Server bindet die Verbindung genau
  einmal an diese User-ID.
- **Kein Sender-Spoofing:** Der Server ignoriert `sender` in `sdp_offer`,
  `sdp_answer`, `ice_candidate` und `lock_request`; als Absender gilt ausschließlich
  die bei `init` serverseitig gesetzte User-ID.
- **Init-Pflicht:** Alle Nachrichten außer `init` werden ohne erfolgreiche
  `init`-Phase abgelehnt (`not_initialized`).
- **Payload-Validierung:** `recipient`, `moduleId` und JSON-Struktur werden vor
  der Verarbeitung validiert; ungültige Nachrichten werden verworfen bzw. mit
  `error` beantwortet, niemals ungeprüft weitergeleitet.
- **Lock-Besitz:** `lock_request` darf nur vom aktuellen Besitzer bzw. nach
  Freigabe/Disconnect erneut gesetzt werden; der Server räumt Locks beim
  Verbindungsabbruch automatisch ab (`lock_status: unlocked`).
- **Heartbeat/Lease:** Langlaufende Installationen sollten zusätzlich einen
  Heartbeat/Lease (z. B. 60 s) einsetzen, damit verwaiste Locks auch bei
  Netzpartitionen nicht dauerhaft blockieren.
- **Versionierung/Rate-Limit:** `lock_status` sollte eine monoton steigende
  `lockVersion` tragen; der Server sollte `lock_request` pro Verbindung
  ratelimited behandeln, um Lock-Hijacking/DoS über unbegrenzte Requests zu
  verhindern.
