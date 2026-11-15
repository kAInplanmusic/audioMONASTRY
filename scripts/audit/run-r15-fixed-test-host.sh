#!/bin/bash
set -euo pipefail
rev=${1:?full commit}; [[ "$rev" =~ ^[a-f0-9]{40}$ ]]
root=/root/r15-fixed-${rev:0:7}; source_dir=/opt/am-r15-fixed-${rev:0:7}; [[ ! -e "$root" ]]
mkdir -p "$root" "$source_dir"
export PATH=/usr/local/bin:$PATH XDG_RUNTIME_DIR=/run/user/0
pulseaudio --check || pulseaudio --start --exit-idle-time=-1
cd "$source_dir";git init -q;git fetch -q --depth=1 https://github.com/kAInplanmusic/audioMONASTRY.git "$rev";git checkout -q --detach FETCH_HEAD;ln -s /opt/am-r11/node_modules node_modules
node build-worklets.mjs > "$root/worklets.log" 2>&1
{ date -u;node -v;nproc;getconf CLK_TCK;git rev-parse HEAD;} > "$root/resources.txt"
runcheck(){ local name=$1;shift;echo "$name" > "$root/status";set +e;"$@" > "$root/$name.log" 2>&1;local code=$?;set -e;echo "$code" > "$root/$name.exit"; }
runcheck typecheck npm run typecheck
runcheck lint npm run lint
runcheck scoped env NODE_ENV=test npx vitest run tests/backendMain{WorkerPipelining,Processors,ProcessorAuthority,Mixer,Transport,Adapter,Resampler,ResamplerPerformance,ProcessorPerformance,Worker,PlaybackProgress}.test.ts --maxWorkers=2
# Probe the repaired path at6/8 with no sampling profiler. Still explicit diagnostic tracing.
for count in 6 8;do
 runcheck diagnosis-$count env R15_SOURCE_COUNT="$count" R15_DURATION_MS=60000 R15_ARTIFACT_DIR="$root/diagnosis-$count" node --import tsx scripts/audit/backendMainTimingDiagnosis.ts
done
runcheck final-8 env R14_SOURCE_COUNT=8 R14_DURATION_MS=60000 R14_ARTIFACT_DIR="$root/final-8" node --import tsx scripts/audit/backendMainWorkerAppProof.ts
# No full-suite/RT reruns: narrow runtime change, targeted108tests plus actual Apps.
echo COLLECTED > "$root/status";tar czf "$root.tar.gz" -C /root "$(basename "$root")";sha256sum "$root.tar.gz" > "$root.sha256"
