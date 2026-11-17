#!/bin/bash
# Reuses retained Hetzner176142753. No provisioning or protected gate commands.
set -euo pipefail
rev=${1:?pinned commit required}
phase=${2:-diagnose}
[[ "$rev" =~ ^[a-f0-9]{40}$ ]]
[[ "$phase" == diagnose || "$phase" == verify ]]
results=/root/r13-${rev:0:7}-$phase
source_dir=/opt/am-r13-${rev:0:7}
[[ ! -e "$results" ]]
mkdir -p "$results"
status=$results/status
trap 'code=$?; if [ "$code" -ne 0 ]; then echo "FAILED $code" > "$status"; fi' EXIT
export XDG_RUNTIME_DIR=/run/user/0
export PATH=/usr/local/bin:$PATH
pulseaudio --check || pulseaudio --start --exit-idle-time=-1
if [[ ! -d "$source_dir" ]]; then
 mkdir -p "$source_dir"
 git -C "$source_dir" init -q
 git -C "$source_dir" fetch -q --depth=1 https://github.com/kAInplanmusic/audioMONASTRY.git "$rev"
 git -C "$source_dir" checkout -q --detach FETCH_HEAD
 ln -s /opt/am-r11/node_modules "$source_dir/node_modules"
fi
cd "$source_dir"
{ date -u; node --version; nproc; lscpu; pactl info; git rev-parse HEAD; } > "$results/resources.txt"
node build-worklets.mjs > "$results/worklets.log" 2>&1
runcheck() {
 local name=$1
 shift
 echo "$name" > "$status"
 set +e
 "$@" > "$results/$name.log" 2>&1
 local code=$?
 set -e
 echo "$code" > "$results/$name.exit"
}
runcheck profile env R13_PROFILE_DIR="$results/processor" node --import tsx scripts/audit/backendMainProcessorProfile.ts
if [[ "$phase" == verify ]]; then
 runcheck src-baseline-clean env R13_SRC_MODULE=/opt/am-r13-ba672bd/src/core/audio/backendMainResampler.ts R13_PROFILE_DIR="$results/src-baseline-clean" node --import tsx scripts/audit/backendMainSrcProfile.ts
fi
runcheck src env R13_PROFILE_DIR="$results/src" node --import tsx scripts/audit/backendMainSrcProfile.ts
if [[ "$phase" == verify ]]; then
 runcheck typecheck npm run typecheck
 runcheck lint npm run lint
 runcheck scoped env NODE_ENV=test npx vitest run tests/backendMainProcessors.test.ts tests/backendMainProcessorAuthority.test.ts tests/backendMainMixer.test.ts tests/backendMainTransport.test.ts tests/backendMainAdapter.test.ts tests/backendMainResampler.test.ts tests/backendMainResamplerPerformance.test.ts tests/backendMainProcessorPerformance.test.ts
fi
duration=40000
[[ "$phase" != verify ]] || duration=60000
for count in 4 6 8; do
 runcheck app-$count env R13_SOURCE_COUNT="$count" R13_DURATION_MS="$duration" R13_ARTIFACT_DIR="$results/app-$count" node --import tsx scripts/audit/backendMainProcessorScalingAppProof.ts
done
python3 - "$results" <<'PY'
from pathlib import Path
import sys,json
root=Path(sys.argv[1]);summary={'checks':{p.stem:int(p.read_text())for p in root.glob('*.exit')},'apps':{}}
for count in [4,6,8]:
 p=root/f'app-{count}/result.json'
 if p.exists():
  r=json.loads(p.read_text());summary['apps'][str(count)]={'status':r['status'],'error':r.get('error'),'assertions':[{'test':a['test'],'passed':a['passed']}for a in r['assertions']]}
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
PY
echo COLLECTED > "$status"
tar -czf "$results.tar.gz" -C /root "$(basename "$results")"
sha256sum "$results.tar.gz" > "$results.sha256"
