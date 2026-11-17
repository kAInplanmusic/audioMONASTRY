#!/bin/bash
# Existing dedicated test VM only. No provisioning, credentials, DNS or firewall changes.
set -euo pipefail
rev=${1:?pinned public source commit required}
[[ "$rev" =~ ^[a-f0-9]{40}$ ]]
results=/root/r12-results-${rev:0:7}
source_dir=/opt/am-r12-${rev:0:7}
[[ ! -e "$results" && ! -e "$source_dir" ]]
mkdir -p "$results" "$source_dir"
status=$results/status
trap 'code=$?; if [ "$code" -ne 0 ]; then echo "FAILED $code" > "$status"; fi' EXIT
export XDG_RUNTIME_DIR=/run/user/0
export PATH=/usr/local/bin:$PATH
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
pulseaudio --check || pulseaudio --start --exit-idle-time=-1
{ date -u; node --version; nproc; lscpu; pactl info; } > "$results/resources.txt"
echo SETUP > "$status"
git -C "$source_dir" init -q
git -C "$source_dir" fetch -q --depth=1 https://github.com/kAInplanmusic/audioMONASTRY.git "$rev"
git -C "$source_dir" checkout -q --detach FETCH_HEAD
git -C "$source_dir" rev-parse HEAD > "$results/revision.txt"
ln -s /opt/am-r11/node_modules "$source_dir/node_modules"
cd "$source_dir"
node build-worklets.mjs > "$results/worklets.log" 2>&1
# Permission tests must exercise an ordinary user; archive exports need real git metadata.
id r12test >/dev/null 2>&1 || useradd -m -s /bin/bash r12test
chown -R r12test:r12test "$source_dir" /opt/am-r11/node_modules
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
runcheck typecheck npm run typecheck
runcheck lint npm run lint
runcheck scoped env NODE_ENV=test npx vitest run tests/backendMainProcessors.test.ts tests/backendMainProcessorAuthority.test.ts tests/backendMainMixer.test.ts tests/backendMainTransport.test.ts tests/backendMainAdapter.test.ts
test_tmp=$(mktemp -d /tmp/am-r12-user.XXXXXX)
chown r12test:r12test "$test_tmp"
runcheck test runuser -u r12test -- env TMPDIR="$test_tmp" npm run test -- --maxWorkers=2
runcheck app env R12_DURATION_MS=60000 R12_ARTIFACT_DIR="$results/app" node --import tsx scripts/audit/backendMainProcessorsAppProof.ts
python3 - "$results" <<'PY'
import pathlib,json,sys
root=pathlib.Path(sys.argv[1]);out={p.stem:int(p.read_text())for p in root.glob('*.exit')}
if (root/'app/result.json').exists():
 r=json.loads((root/'app/result.json').read_text());out['app_status']=r['status'];out['error']=r.get('error');out['assertions']=[{'test':a['test'],'passed':a['passed']}for a in r['assertions']]
(root/'summary.json').write_text(json.dumps(out,indent=2)+'\n')
PY
echo COLLECTED > "$status"
tar -czf "$results.tar.gz" -C /root "$(basename "$results")"
sha256sum "$results.tar.gz" > "$results.sha256"
# Full suite can remain red; inspect summary instead of representing collection as a pass.
