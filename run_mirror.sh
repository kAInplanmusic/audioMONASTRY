#!/usr/bin/env bash
set -e
cd /mnt/wd-elements/Medien/Projekte/audioMONASTRY
# Load environment variables from .env.deploy
set -a
source .env.deploy
set +a
# Run the mirror script
python3 scripts/weights-mirror.py --only brain --yes
