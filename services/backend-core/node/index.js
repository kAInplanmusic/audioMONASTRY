const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });
const IDLE_TIMEOUT_MS = Number(process.env.SIGNALING_IDLE_TIMEOUT_MS || 20 * 60 * 1000);

// State-Management
const clients = new Map(); // userId -> ws
const lockState = new Map(); // moduleId -> userId

function broadcast(msg) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(msg));
    }
  });
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

  refreshIdleTimer();

  ws.on('message', (message) => {
    refreshIdleTimer();
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.error('Invalid message format:', e);
      return;
    }

    // 1. Initialisierung (User ID setzen)
    if (data.type === 'init') {
      userId = data.sender;
      clients.set(userId, ws);
      console.log(`User ${userId} joined.`);
    }

    // 2. WebRTC Signaling (Routing)
    else if (['sdp_offer', 'sdp_answer', 'ice_candidate'].includes(data.type)) {
      const recipientWs = clients.get(data.recipient);
      if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
        recipientWs.send(message);
      }
    }

    // 3. Locking Logic (Synchronisation)
    else if (data.type === 'lock_request') {
      const { moduleId } = data.payload;
      if (!lockState.has(moduleId)) {
        lockState.set(moduleId, userId);
        broadcast({ 
          type: 'lock_status', 
          sender: 'server',
          payload: { moduleId, userId, status: 'locked' } 
        });
      }
    }
  });

  ws.on('close', () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (userId) {
      console.log(`User ${userId} left.`);
      clients.delete(userId);
      // Cleanup Locks
      for (const [moduleId, ownerId] of lockState.entries()) {
        if (ownerId === userId) {
          lockState.delete(moduleId);
          broadcast({ 
            type: 'lock_status', 
            sender: 'server',
            payload: { moduleId, userId: null, status: 'unlocked' } 
          });
        }
      }
    }
  });
});

console.log('Signaling server running on ws://localhost:8080');
