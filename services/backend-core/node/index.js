const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });
const IDLE_TIMEOUT_MS = Number(process.env.SIGNALING_IDLE_TIMEOUT_MS || 20 * 60 * 1000);
const MAX_CLIENTS = Math.max(1, Number(process.env.SIGNALING_MAX_CLIENTS || 500));

const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// State-Management
const clients = new Map(); // userId -> ws
const lockState = new Map(); // moduleId -> userId

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidUserId(value) {
  return typeof value === 'string' && USER_ID_PATTERN.test(value);
}

function isValidModuleId(value) {
  return typeof value === 'string' && MODULE_ID_PATTERN.test(value);
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(msg) {
  wss.clients.forEach((client) => send(client, msg));
}

wss.on('connection', (ws) => {
  let userId = null;
  let idleTimer = null;

  const refreshIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.log(`Closing idle signaling client ${userId || 'unknown'} after ${IDLE_TIMEOUT_MS}ms.`);
      ws.close(4000, 'Idle timeout');
    }, IDLE_TIMEOUT_MS);
  };

  const sendError = (code, message) => {
    send(ws, { type: 'error', sender: 'server', payload: { code, message } });
  };

  refreshIdleTimer();

  ws.on('message', (message) => {
    refreshIdleTimer();
    try {
      let data;
      try {
        data = JSON.parse(message);
      } catch (e) {
        console.error('Invalid message format:', e);
        sendError('invalid_json', 'Message must be valid JSON.');
        return;
      }

      if (!isPlainObject(data)) {
        sendError('invalid_message', 'Message must be a JSON object.');
        return;
      }

      // 1. Initialisierung (User ID setzen)
      if (data.type === 'init') {
        const candidate = typeof data.sender === 'string' ? data.sender.trim() : '';
        if (!isValidUserId(candidate)) {
          sendError('invalid_user_id', 'sender must be a non-empty string with max 128 chars (letters, digits, . _ : -).');
          return;
        }
        if (userId && userId !== candidate) {
          sendError('init_conflict', 'This connection is already bound to another user id.');
          return;
        }

        // Doppelte userId: alte Verbindung schließen, damit die clients-Map
        // immer die aktuelle Verbindung referenziert.
        const existing = clients.get(candidate);
        if (existing && existing !== ws) {
          existing.close(4001, 'Session replaced by a new connection.');
        } else if (!existing && clients.size >= MAX_CLIENTS) {
          // Schutz vor unbegrenztem Wachstum der clients-Map: keine neuen
          // userIds mehr aufnehmen, wenn die Obergrenze erreicht ist.
          sendError('server_full', `Maximum number of concurrent clients (${MAX_CLIENTS}) reached.`);
          ws.close(4002, 'Server full');
          return;
        }

        userId = candidate;
        clients.set(userId, ws);
        console.log(`User ${userId} joined.`);
        send(ws, { type: 'init_ack', sender: 'server', payload: { userId } });
        return;
      }

      // Alle anderen Nachrichten erfordern eine erfolgreiche init-Phase.
      if (!userId) {
        sendError('not_initialized', 'Send init with a valid sender first.');
        return;
      }

      // 2. WebRTC Signaling (Routing) – Absender ist serverseitig bekannt,
      // der Client kann data.sender nicht spoofing-weise selbst bestimmen.
      if (['sdp_offer', 'sdp_answer', 'ice_candidate'].includes(data.type)) {
        const recipient = typeof data.recipient === 'string' ? data.recipient : '';
        if (!isValidUserId(recipient)) {
          sendError('invalid_recipient', 'recipient must be a valid user id.');
          return;
        }
        if (recipient === userId) {
          sendError('invalid_recipient', 'recipient must differ from sender.');
          return;
        }
        const recipientWs = clients.get(recipient);
        if (!recipientWs || recipientWs.readyState !== WebSocket.OPEN) {
          sendError('recipient_not_found', `Recipient ${recipient} is not online.`);
          return;
        }
        recipientWs.send(message);
        return;
      }

      // 3. Locking Logic (Synchronisation)
      if (data.type === 'lock_request') {
        const payload = data.payload;
        const moduleId = isPlainObject(payload) ? payload.moduleId : undefined;
        if (!isValidModuleId(moduleId)) {
          sendError('invalid_module_id', 'payload.moduleId must be a non-empty string with max 128 chars (letters, digits, . _ : -).');
          return;
        }
        if (!lockState.has(moduleId)) {
          lockState.set(moduleId, userId);
          broadcast({
            type: 'lock_status',
            sender: 'server',
            payload: { moduleId, userId, status: 'locked' },
          });
        } else {
          const ownerId = lockState.get(moduleId);
          send(ws, {
            type: 'lock_status',
            sender: 'server',
            payload: { moduleId, userId: ownerId, status: 'locked', granted: false, reason: 'already_locked' },
          });
        }
        return;
      }
    } catch (error) {
      // Kein uncaught exception im Event-Handler: Prozess darf nicht crashen.
      console.error('Unexpected signaling handler error:', error);
      sendError('internal_error', 'Unexpected server error while processing message.');
    }
  });

  ws.on('close', () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (userId) {
      // Nur löschen, wenn diese Verbindung noch die registrierte ist
      // (Schutz gegen duplicate-init-Race).
      if (clients.get(userId) === ws) {
        clients.delete(userId);
      }
      console.log(`User ${userId} left.`);
      // Cleanup Locks
      for (const [moduleId, ownerId] of lockState.entries()) {
        if (ownerId === userId) {
          lockState.delete(moduleId);
          broadcast({
            type: 'lock_status',
            sender: 'server',
            payload: { moduleId, userId: null, status: 'unlocked' },
          });
        }
      }
    }
  });
});

console.log('Signaling server running on ws://localhost:8080');
