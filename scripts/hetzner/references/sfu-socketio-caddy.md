# SFU Socket.IO Caddy Configuration

## Socket.IO Path Routing

When mediasoup Socket.IO is configured with a custom path:

```typescript
const sfuIo = new Server(httpServer, {
  path: '/sfu-signaling',
});
```

The Socket.IO client **always** connects to `{path}/socket.io/?EIO=4&transport=polling`.

### Correct Caddy Configuration

```
@sfu path /sfu-signaling/socket.io*
handle @sfu {
  reverse_proxy audiomonastry:8080 {
    transport http {
      read_timeout 5m
      write_timeout 5m
    }
  }
}

@sfubase path /sfu-signaling
handle @sfubase {
  reverse_proxy audiomonastry:8080 {
    transport http {
      read_timeout 5m
      write_timeout 5m
    }
  }
}
```

### Common Pitfall

**DO NOT use `@sig path /sfu-signaling/*`** - this pattern fails to match the full Socket.IO path and causes:
- HTTP 400 responses from Socket.IO
- "xhr poll error" in clients
- Failed WebRTC connections

The `@sig` pattern catches only `/sfu-signaling/*` but the client requests `/sfu-signaling/socket.io/...`.

### Verification

Test the endpoint after configuration:

```bash
curl -fsS "https://sfu.example.de/sfu-signaling/socket.io/?EIO=4&transport=polling"
# Expected: 0{"sid":"...","upgrades":["websocket"],...}
```

## SFU Caddyfile Files

- `scripts/hetzner/Caddyfile.dns01` - Combined main domain + SFU routing (DNS-01 TLS)
- `scripts/hetzner/Caddyfile.sfu` - SFU-only routing (for dedicated SFU domain)