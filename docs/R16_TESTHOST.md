# CCX33 Testhost

## Server Details

- **Name:** am-ccx33
- **IP:** 135.181.111.103
- **Type:** CCX33 (8 vCPU, 32 GB RAM)
- **Purpose:** R16/R18 Testing & Integration
- **Location:** Hetzner Cloud (fsn1)

## Access

```bash
ssh root@135.181.111.103
```

## Starting the Server

```bash
# Ensure server is running
export HETZNER_TOKEN="your-token"
curl -X POST -H "Authorization: Bearer $HETZNER_TOKEN" \
  -H "Content-Type: application/json" \
  "https://api.hetzner.cloud/v1/servers/176222845/actions/poweron"
```

Or use the helper script:
```bash
CCX33_IP=135.181.111.103 HETZNER_TOKEN=$HETZNER_TOKEN \
  ./scripts/audit/ensure-testhost-up.sh
```

## Running Integration Tests

```bash
# Run backend main tests
npx vitest run tests/backendMain*.test.ts

# Run specific limiter tests
npx vitest run tests/backendMainLimiter.test.ts

# Build and start server
npm run build
npm run start
```

## R18 Integration Tests

### Test Results (156/156 passing)

| Test Case | Ergebnis | Anmerkung |
|-----------|----------|-----------|
| 4 Quellen + Limiter an | ✅ PASS | PA stabil |
| 6 Quellen + Limiter an | ✅ PASS | CPU innerhalb Grenze |
| Limiter +6dB über Ceiling | ✅ PASS | Waveform GR angezeigt, PA nicht clipped |
| Bit-Parität Limiter OFF (72/72) | ✅ PASS | Transparent bypass |

### CPU Load
- 6 Quellen + Limiter: < 3.8 vCPU (gemessen auf CCX33)
- Limiter Lookahead: 5ms (240 Samples @ 48kHz)

## R19 Implementation

### True-Peak Telemetry (Vorbereitung)
- `MainWaveform` interface erweitert um optionale Felder:
  - `truePeakL?: number`
  - `truePeakR?: number`
- Platzhalter für R20 (Oversampling-Berechnung)

### Visueller 12-Band-EQ (Canvas-basiert)
- Implementiert in `src/components/master/VisualEq.tsx`
- Drag-and-drop für Frequenzbandpunkte
- Log-skaliertes Frequenzdiagramm (20Hz - 20kHz)
- Farbschema: Blau → Lila → Pink (Gradient)

## R18 Latenzkompensation

Siehe `docs/R18_LATENZKOMPENSATION.md` für Details.

Kurzfassung: Keine zusätzliche Kompensation erforderlich.
Beide Pfade (PA und Monitor) erhalten über WebSocket dieselbe verzögerte Audiospur.

## Deployment

The server runs from `/opt/am-r16-impl/`. To deploy changes:

```bash
# SSH to server
ssh root@135.181.111.103

# Copy and deploy
cp /tmp/backendMainProcessors.ts.new /opt/am-r16-impl/server/backendMainProcessors.ts
cp /tmp/backendMainLimiter.test.ts.new /opt/am-r16-impl/tests/backendMainLimiter.test.ts
cd /opt/am-r16-impl
npm run typecheck
npm run test
npm run build
# Restart via systemd or pm2
```

## Notes

- Server has auto-shutdown enabled (R16 policy)
- Floating IP: 135.181.111.103
- Default password: managed via ~/.ssh/hallerbans_key
- TLS certificates via certbot
- Logs: `/var/log/am-r16-impl/`