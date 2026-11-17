#!/bin/bash
# ensure-testhost-up.sh - Ensure CCX33 test host is running and accessible
# Usage: ./scripts/audit/ensure-testhost-up.sh

set -euo pipefail

HETZNER_TOKEN="${HETZNER_TOKEN:-}"
CCX33_NAME="am-ccx33"
EXPECTED_IP="${CCX33_IP:-135.181.111.103}"

if [[ -z "$HETZNER_TOKEN" ]]; then
  echo "ERROR: HETZNER_TOKEN not set"
  exit 1
fi

echo "Checking CCX33 test host ($CCX33_NAME)..."

# Get server by label
SERVER_JSON=$(curl -s -H "Authorization: Bearer $HETZNER_TOKEN" \
  "https://api.hetzner.cloud/v1/servers?per_page=50")

SERVER_ID=$(echo "$SERVER_JSON" | jq -r '.servers[] | select(.labels.name == "am-ccx33" or .name == "am-ccx33" or .labels.purpose == "r16-testhost") | .id' | head -1)

if [[ -z "$SERVER_ID" || "$SERVER_ID" == "null" ]]; then
  echo "ERROR: Server $CCX33_NAME not found"
  exit 1
fi

echo "Found server ID: $SERVER_ID"

# Check server status
STATUS=$(echo "$SERVER_JSON" | jq -r ".servers[] | select(.id == $SERVER_ID) | .status")
echo "Server status: $STATUS"

# Get public IP
PUBLIC_IP=$(echo "$SERVER_JSON" | jq -r ".servers[] | select(.id == $SERVER_ID) | .public_ips[0] // empty")

if [[ "$STATUS" == "running" && -n "$PUBLIC_IP" ]]; then
  echo "Server is running with public IP: $PUBLIC_IP"
  
  # Test SSH connectivity
  if ssh -o ConnectTimeout=5 -o BatchMode=yes root@"$PUBLIC_IP" echo "SSH_OK" 2>/dev/null; then
    echo "SSH connectivity verified"
    echo "CCX33 is ready at $PUBLIC_IP"
    exit 0
  else
    echo "WARNING: Server running but SSH not accessible"
    echo "IP: $PUBLIC_IP"
  fi
elif [[ "$STATUS" == "running" && -z "$PUBLIC_IP" ]]; then
  echo "Server running but no public IP assigned"
  echo "Attempting to assign floating IP..."
  
  # Try to get floating IP for this server
  # (In production, this would need the correct floating IP ID)
  echo "No floating IP configured - manual assignment needed"
  exit 2
else
  echo "Starting server..."
  
  # Start the server
  RESULT=$(curl -s -X POST \
    -H "Authorization: Bearer $HETZNER_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.hetzner.cloud/v1/servers/$SERVER_ID/actions/poweron")
  
  ACTION_ID=$(echo "$RESULT" | jq -r '.action.id')
  echo "Power-on action started: $ACTION_ID"
  
  # Wait for server to start
  for i in {1..30}; do
    sleep 10
    STATUS=$(curl -s -H "Authorization: Bearer $HETZNER_TOKEN" \
      "https://api.hetzner.cloud/v1/servers/$SERVER_ID" | jq -r '.server.status')
    echo "Waiting for server... ($i/30) Status: $STATUS"
    
    if [[ "$STATUS" == "running" ]]; then
      break
    fi
  done
  
  echo "Server status: $STATUS"
fi

exit 0