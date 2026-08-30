const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const IDLE_TIMEOUT_MS = Number(process.env.SIGNALING_IDLE_TIMEOUT_MS || 20 * 60 * 1000);
const ALLOWED_ORIGINS = process.env.SIGNALING_ALLOWED_ORIGINS
  ? process.env.SIGNALING_ALLOWED_ORIGINS.split(',')
  : [];

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
    methods: ["GET", "POST"]
  }
});

// Simple structured logging
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

io.on('connection', (socket) => {
  log(`User connected: ${socket.id}`);

  let idleTimer = null;
  const refreshIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log(`Disconnecting idle socket ${socket.id} after ${IDLE_TIMEOUT_MS}ms without signaling activity.`);
      socket.disconnect(true);
    }, IDLE_TIMEOUT_MS);
  };

  refreshIdleTimer();

  // WebRTC Signaling with validation
  socket.on('offer', (data) => {
    refreshIdleTimer();
    if (!data.target || !data.offer) {
      log(`Invalid offer received from ${socket.id}`);
      return;
    }
    socket.to(data.target).emit('offer', {
      offer: data.offer,
      sender: socket.id
    });
    log(`Offer relayed from ${socket.id} to ${data.target}`);
  });

  socket.on('answer', (data) => {
    refreshIdleTimer();
    if (!data.target || !data.answer) {
      log(`Invalid answer received from ${socket.id}`);
      return;
    }
    socket.to(data.target).emit('answer', {
      answer: data.answer,
      sender: socket.id
    });
    log(`Answer relayed from ${socket.id} to ${data.target}`);
  });

  socket.on('ice-candidate', (data) => {
    refreshIdleTimer();
    if (!data.target || !data.candidate) {
      log(`Invalid ICE candidate received from ${socket.id}`);
      return;
    }
    socket.to(data.target).emit('ice-candidate', {
      candidate: data.candidate,
      sender: socket.id
    });
    log(`ICE candidate relayed from ${socket.id} to ${data.target}`);
  });

  socket.on('activity', refreshIdleTimer);

  socket.on('disconnect', (reason) => {
    if (idleTimer) clearTimeout(idleTimer);
    log(`User disconnected: ${socket.id}, reason: ${reason}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  log(`Signaling server running on port ${PORT}`);
});
