#!/bin/bash
set -euo pipefail
rev=${1:?full commit}; [[ "$rev" =~ ^[a-f0-9]{40}$ ]]
root=/root/r14-${rev:0:7}; source_dir=/opt/am-r14-${rev:0:7}; [[ ! -e "$root" ]]
mkdir -p "$root" "$source_dir"
export PATH=/usr/local/bin:$PATH XDG_RUNTIME_DIR=/run/user/0
pulseaudio --check || pulseaudio --start --exit-idle-time=-1
cd "$source_dir"
git init -q; git fetch -q --depth=1 https://github.com/kAInplanmusic/audioMONASTRY.git "$rev"; git checkout -q --detach FETCH_HEAD
ln -s /opt/am-r11/node_modules node_modules
node build-worklets.mjs > "$root/worklets.log" 2>&1
{ date -u; node -v; nproc; getconf CLK_TCK; pactl info; git rev-parse HEAD; } > "$root/resources.txt"
runcheck() { local name=$1; shift; echo "$name" > "$root/status"; set +e; "$@" > "$root/$name.log" 2>&1; local code=$?; set -e; echo "$code" > "$root/$name.exit"; }
runcheck typecheck npm run typecheck
runcheck lint npm run lint
runcheck scoped env NODE_ENV=test npx vitest run tests/backendMain{Processors,ProcessorAuthority,Mixer,Transport,Adapter,Resampler,ResamplerPerformance,ProcessorPerformance,Worker,PlaybackProgress}.test.ts --maxWorkers=2
runcheck profile env R13_PROFILE_DIR="$root/profile" node --import tsx scripts/audit/backendMainProcessorProfile.ts
runcheck src env R13_PROFILE_DIR="$root/src" node --import tsx scripts/audit/backendMainSrcProfile.ts
for count in 4 6 8; do
 runcheck app-$count env R14_SOURCE_COUNT="$count" R14_DURATION_MS=60000 R14_ARTIFACT_DIR="$root/app-$count" node --import tsx scripts/audit/backendMainWorkerAppProof.ts
done
# Full suite honestly includes known boundary/masterRoutes failures. Private TMPDIR avoids historical EACCES.
tmp_test=$(mktemp -d /tmp/r14-tests-XXXX); chown r12test "$tmp_test"
runcheck npm-test runuser -u r12test -- env TMPDIR="$tmp_test" npm run test -- --maxWorkers=2
# Also verify the production worker artifact can be built without invoking protected RT/audio gates.
runcheck worker-build npx esbuild server/backendMainWorker.ts --bundle --platform=node --format=cjs --packages=external --outfile="$root/backendMainWorker.cjs"
echo COLLECTED > "$root/status"
tar czf "$root.tar.gz" -C /root "$(basename "$root")"; sha256sum "$root.tar.gz" > "$root.sha256"
