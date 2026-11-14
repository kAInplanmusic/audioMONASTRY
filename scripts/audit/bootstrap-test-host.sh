#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
mkdir -p /root/r11-results
status=/root/r11-results/status
trap 'code=$?; if [ "$code" -ne 0 ]; then echo "FAILED $code" > "$status"; fi' EXIT
echo INSTALLING > "$status"
apt-get update -qq
apt-get install -y -qq ca-certificates curl xz-utils ffmpeg > /root/apt-r11.log 2>&1
cd /root
curl -fLsS --retry 3 https://nodejs.org/dist/v22.16.0/node-v22.16.0-linux-x64.tar.xz -o node-v22.16.0-linux-x64.tar.xz
curl -fLsS https://nodejs.org/dist/v22.16.0/SHASUMS256.txt -o SHASUMS256.txt
grep ' node-v22.16.0-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum -c -
tar -xJf node-v22.16.0-linux-x64.tar.xz --strip-components=1 -C /usr/local
mkdir -p /opt/am-r11
curl -fLsS --retry 3 https://codeload.github.com/kAInplanmusic/audioMONASTRY/tar.gz/cddd5cd0e54919c41ac8b6c21abfc196bbc54953 -o source.tar.gz
tar -xzf source.tar.gz --strip-components=1 -C /opt/am-r11
cd /opt/am-r11
npm ci --no-audit --no-fund > /root/npm-ci-r11.log 2>&1
npx playwright install --with-deps chromium > /root/playwright-r11.log 2>&1
node build-worklets.mjs > /root/worklets-r11.log 2>&1
python3 - <<'PY'
from pathlib import Path
p=Path('scripts/audit/backendMainTimelineDiagnosis.ts');s=p.read_text()
s=s.replace('const instrumentation = `', "const instrumentation = `\nimport { Server } from 'node:http';\nconst listen = Server.prototype.listen;\nServer.prototype.listen = function(...args) { if (typeof args[0] === 'number') { if (typeof args[1] === 'string') args[1] = '127.0.0.1'; else args.splice(1,0,'127.0.0.1'); } return Reflect.apply(listen,this,args); };\n")
s=s.replace("'--no-sandbox', '--autoplay-policy=no-user-gesture-required'", "'--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'")
Path('scripts/audit/remote-diagnosis.ts').write_text(s)
PY
{ date -u; node --version; nproc; cat /sys/fs/cgroup/cpu.max; lscpu; cat /proc/stat; } > /root/r11-results/resources-before.txt
for test in targets1 targets2; do
 echo "RUNNING $test" > "$status"
 R11_DURATION_MS=40000 R11_PLUGINS=drop,song,drumsampler,instru R11_ARTIFACT_DIR=/root/r11-results/$test node --import tsx scripts/audit/remote-diagnosis.ts > /root/r11-results/$test-command.log 2>&1
done
{ date -u; cat /sys/fs/cgroup/cpu.stat; cat /proc/stat; } > /root/r11-results/resources-after.txt
python3 - <<'PY'
import json,pathlib
root=pathlib.Path('/root/r11-results');out=[]
for case in ['targets1','targets2']:
 r=json.loads((root/case/'result.json').read_text())
 for m in r.get('members',[]):
  net=m['network'];span=net[-1]['wall']-net[0]['wall']if len(net)>1 else 0
  capture=m['capture'];native=capture[0]['rate'];ratio=(capture[-1]['write']-capture[0]['write'])/native*1000/(capture[-1]['wall']-capture[0]['wall'])
  plugin=m['handshakes'][0]['plugin']if m['handshakes']else '?';packets=m['packets'].get(plugin,{})
  out.append({'case':case,'plugin':plugin,'span_ms':span,'clock_ratio':round(ratio,5),'closes':m['closes'],'nonzero':packets.get('nonzero',0),'pass':not m['closes']and span>=30000 and packets.get('nonzero',0)>0})
(root/'summary.json').write_text(json.dumps(out,indent=2)+'\n')
with (root/'summary.txt').open('w')as f:
 for x in out:f.write(f"{x['case']} {x['plugin']} span={x['span_ms']}ms clock={x['clock_ratio']} closes={len(x['closes'])} pass={x['pass']}\n")
 f.write('ALL_PASS='+str(len(out)==8 and all(x['pass']for x in out))+'\n')
PY
tar -czf /root/r11-results.tar.gz -C /root r11-results
sha256sum /root/r11-results.tar.gz > /root/r11-results/sha256.txt
echo COMPLETE > "$status"
