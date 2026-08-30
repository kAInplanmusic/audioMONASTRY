#!/bin/bash
# deploy-turn.sh - Automated TURN server setup

echo "Installing coturn..."
sudo apt-get update && sudo apt-get install -y coturn

echo "Configuring coturn..."
sudo cp /home/painfulltattoo/sample-monk/services/turn/turnserver.conf /etc/turnserver.conf

echo "Starting and enabling coturn service..."
sudo systemctl enable coturn
sudo systemctl restart coturn

echo "TURN server deployed successfully."
