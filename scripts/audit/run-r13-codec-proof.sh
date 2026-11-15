#!/bin/bash
set -euo pipefail
rev=${1:?commit}; encoding=${2:?auto or pcm24}; count=${3:?source count}; label=${4:-trial}
[[ "$rev" =~ ^[a-f0-9]{40}$ && "$encoding" =~ ^(auto|pcm24)$ && "$count" =~ ^(4|6|8)$ && "$label" =~ ^[a-z0-9-]+$ ]]
results=/root/r13-codec-${rev:0:7}-$encoding-$count-$label
source_dir=/opt/am-r13-${rev:0:7}
[[ ! -e "$results" ]]
mkdir -p "$results"
export PATH=/usr/local/bin:$PATH XDG_RUNTIME_DIR=/run/user/0
pulseaudio --check || pulseaudio --start --exit-idle-time=-1
if [[ ! -d "$source_dir" ]]; then
 mkdir -p "$source_dir"
 git -C "$source_dir" init -q
 git -C "$source_dir" fetch -q --depth=1 https://github.com/kAInplanmusic/audioMONASTRY.git "$rev"
 git -C "$source_dir" checkout -q --detach FETCH_HEAD
 ln -s /opt/am-r11/node_modules "$source_dir/node_modules"
fi
cd "$source_dir"
node build-worklets.mjs > "$results/worklets.log" 2>&1
{ date -u; node --version; nproc; pactl info; git rev-parse HEAD; } > "$results/resources.txt"
echo RUNNING > "$results/status"
set +e
R13_ENCODING="$encoding" R13_SOURCE_COUNT="$count" R13_DURATION_MS=60000 R13_ARTIFACT_DIR="$results/app" node --import tsx scripts/audit/backendMainProcessorScalingAppProof.ts > "$results/app.log" 2>&1
code=$?
set -e
echo "$code" > "$results/app.exit"
echo COLLECTED > "$results/status"
tar -czf "$results.tar.gz" -C /root "$(basename "$results")"
sha256sum "$results.tar.gz" > "$results.sha256"
