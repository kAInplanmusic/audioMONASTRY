"""Snapshot-preserving production bootstrap, run only by Hetzner cloud-init.

Configuration is read from a root-only file, never from CLI arguments or logs.
Only allowlisted deployment metadata is written to the private R2 report.
"""
import datetime
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path('/opt/audiomonastry')


def s3_request(config, method, key, body=b''):
    endpoint = config['updates']['CFS3_ENDPOINT'].rstrip('/')
    if not endpoint.startswith('https://'):
        raise ValueError('HTTPS storage endpoint required')
    host = urllib.parse.urlsplit(endpoint).netloc
    path = '/' + config['updates']['CFS3_BUCKET'] + '/' + urllib.parse.quote(key, safe='/')
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp, date = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
    digest = hashlib.sha256(body).hexdigest()
    headers = {'host':host, 'x-amz-content-sha256':digest, 'x-amz-date':stamp}
    signed = ';'.join(sorted(headers))
    canonical = method+'\n'+path+'\n\n'+''.join(k+':'+headers[k]+'\n' for k in sorted(headers))+'\n'+signed+'\n'+digest
    scope = date+'/auto/s3/aws4_request'
    tosign = 'AWS4-HMAC-SHA256\n'+stamp+'\n'+scope+'\n'+hashlib.sha256(canonical.encode()).hexdigest()
    secret = ('AWS4'+config['updates']['CFS3_SECRET_KEY']).encode()
    for value in (date,'auto','s3','aws4_request'):
        secret=hmac.new(secret,value.encode(),hashlib.sha256).digest()
    signature=hmac.new(secret,tosign.encode(),hashlib.sha256).hexdigest()
    headers['Authorization']='AWS4-HMAC-SHA256 Credential='+config['updates']['CFS3_ACCESS_KEY']+'/'+scope+', SignedHeaders='+signed+', Signature='+signature
    request=urllib.request.Request(endpoint+path,data=body if method=='PUT' else None,method=method,headers=headers)
    with urllib.request.urlopen(request,timeout=30) as response:
        return response.read()


def env_read():
    return {k.strip():v.strip().strip('\"\'') for l in (ROOT/'.env').read_text().splitlines()
            if not l.startswith('#') and '=' in l for k,v in [l.split('=',1)]}


def env_merge(updates):
    path=ROOT/'.env'
    lines=[l for l in path.read_text().splitlines() if l.partition('=')[0].strip() not in updates]
    assert all('\n' not in str(v) and '\r' not in str(v) for v in updates.values())
    path.write_text('\n'.join(lines+[k+'='+str(v) for k,v in updates.items()])+'\n')
    path.chmod(0o600)


def run(args, env=None, timeout=1800):
    result=subprocess.run(args,cwd=ROOT,env=env,timeout=timeout)
    if result.returncode:
        raise RuntimeError('COMMAND_FAILED')


def snapshot_caddy_override():
    """Reuse the exact DNS-capable Caddy artifact retained in the role snapshot.

    The old registry tag is unavailable. An image ID from the existing container
    is content addressed; a mutable tag or a fresh unpinned plugin build is not
    needed to recover this deployment.
    """
    result = subprocess.run(['docker', 'inspect', '--format', '{{.Image}}', 'audiomonastry-caddy'],
                            capture_output=True, text=True, check=True)
    image = result.stdout.strip()
    import re
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        raise RuntimeError('CADDY_SNAPSHOT_IMAGE_INVALID')
    modules = subprocess.run(['docker', 'run', '--rm', '--entrypoint', '/usr/bin/caddy', image, 'list-modules'],
                             capture_output=True, text=True, timeout=60, check=True)
    if 'dns.providers.cloudflare' not in modules.stdout.splitlines():
        raise RuntimeError('CADDY_DNS_MODULE_MISSING')
    path = ROOT / 'runtime/production-caddy.json'
    path.parent.mkdir(mode=0o700, exist_ok=True)
    path.write_text(json.dumps({'services': {'caddy': {'image': image, 'pull_policy': 'never'}}}))
    path.chmod(0o600)
    return path, image


def main():
    os.umask(0o077)
    config=json.loads(Path('/root/audiomonastry-production.json').read_text())
    role=config['role']
    report={'role':role,'commit':config['commit'],'stage':'starting','checks':{}}
    key='deployment/2026-11-12-production/'+role+'.json'
    def publish(stage):
        report.update(stage=stage,updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        s3_request(config,'PUT',key,json.dumps(report).encode())
        if config.get('evidencePrefix'):
            s3_request(config,'PUT',config['evidencePrefix']+'/deploy-'+role+'.json',json.dumps(report).encode())
    try:
        publish('preflight')
        assert role in ('app','sfu','media','edge')
        ROOT.mkdir(parents=True,exist_ok=True)
        if not (ROOT/'.env').is_file():
            assert config.get('seedEnv')
            (ROOT/'.env').write_text('\n'.join(k+'='+v for k,v in config['seedEnv'].items())+'\n')
            (ROOT/'.env').chmod(0o600)
        env_merge({k:v for k,v in config['updates'].items() if k in ('STUDIO_ACCESS_TOKEN','SESSION_SECRET','SCRAPE_TOKEN','TURN_STATIC_AUTH_SECRET')})
        existing=env_read()
        if len(existing.get('STUDIO_ACCESS_TOKEN',''))<32:raise RuntimeError('STUDIO_AUTH_MISSING','SUPABASE_URL_INVALID')
        backup=Path('/root/audiomonastry-before-production')
        backup.mkdir(mode=0o700,exist_ok=True)
        shutil.copy2(ROOT/'.env',backup/'.env')
        request=urllib.request.Request('https://api.github.com/repos/kAInplanmusic/audioMONASTRY/tarball/'+config['commit'],
            headers={'Authorization':'Bearer '+config['sourceToken'],'User-Agent':'audioMONASTRY-ProductionDeploy/1.0'})
        with urllib.request.urlopen(request,timeout=180) as response:
            archive=response.read()
        with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as source:
            for member in source.getmembers():
                parts=Path(member.name).parts
                if len(parts)<2 or parts[1] in ('.env','media','certs','runtime','Caddyfile'):
                    continue
                member.name='/'.join(parts[1:])
                source.extract(member,path=ROOT,filter='data')
        # Retain Git metadata for build identity, but never a credentialed remote.
        run(['git','-c','safe.directory='+str(ROOT),'init','-q'])
        run(['git','-c','safe.directory='+str(ROOT),'config','user.name','audioMONASTRY Production'])
        run(['git','-c','safe.directory='+str(ROOT),'config','user.email','production@hallerbans.de'])
        # Build source identity is also passed explicitly to the Docker build.
        updates=dict(config['updates'])
        updates.update({'DOMAIN':'hallerbans.de','ORIGIN_HOST':'origin.hallerbans.de',
            'SFU_SIGNALING_URL':'https://sfu.hallerbans.de','SFU_SIGNALING_PATH':'/sfu-signaling',
            'SFU_ANNOUNCED_IP':config['nodes']['sfu'],'ENABLE_SFU':'1' if role=='sfu' else '0'})
        url=updates.get('SUPABASE_URL') or existing.get('SUPABASE_URL') or existing.get('SB_URL') or existing.get('VITE_SUPABASE_URL') or existing.get('VITE_SB_URL')
        if not url or not url.startswith('https://'):raise RuntimeError('SUPABASE_URL_INVALID')
        anon=updates.get('SUPABASE_ANON_PUB') or existing.get('VITE_SUPABASE_ANON_PUB') or existing.get('VITE_SB_ANON_PUB')
        assert anon
        updates.update(SUPABASE_URL=url,SB_URL=url,SUPABASE_ANON_PUB=anon,SB_ANON_PUB=anon,VITE_SUPABASE_URL=url,VITE_SB_URL=url,VITE_SUPABASE_ANON_PUB=anon,VITE_SB_ANON_PUB=anon)
        if role=='app':updates['MASTER_PLAYER_URL']='http://master-player:8000'
        env_merge(updates)
        # Use the same credential pair for every legacy alias still present.
        current=env_read()
        aliases={'CFS3_ACCESS_KEY':['CFS3_ACCESS_KEY_ID','CFR2_ACCESS_KEY_ID','CFR2_ACCESS_KEY'],
            'CFS3_SECRET_KEY':['CFS3_SECRET_ACCESS_KEY','CFR2_SECRET_ACCESS_KEY','CFR2_SECRET_KEY'],
            'CFS3_BUCKET':['CFR2_BUCKET'],'CFS3_ENDPOINT':['CFR2_ENDPOINT']}
        env_merge({alias:current[key] for key,names in aliases.items() for alias in names if alias in current})
        publish('source_installed')
        login=subprocess.run(['docker','login','ghcr.io','--username',updates['GHCR_USERNAME'],'--password-stdin'],input=updates['GHCR_PASSWORD'].encode(),capture_output=True)
        if login.returncode:raise RuntimeError('REGISTRY_LOGIN_FAILED')
        compose=['docker','compose','-f','docker-compose.hetzner.yml']
        caddy_override = None
        if role in ('app', 'sfu'):
            caddy_override, caddy_image = snapshot_caddy_override()
            report['caddyImageId'] = caddy_image
            report['checks']['caddyDnsModuleVerified'] = True
        if role=='edge':
            run(compose+['-f','docker-compose.monitoring.yml','stop','caddy','audiomonastry','master-player'])
            run(compose+['-f','docker-compose.monitoring.yml','up','-d','node-exporter','cadvisor','prometheus','alertmanager','grafana'])
        else:
            if role=='sfu':
                shutil.copyfile(ROOT/'scripts/hetzner/Caddyfile.sfu',ROOT/'Caddyfile')
                compose+=['-f','docker-compose.sfu.yml','-f','docker-compose.turn.yml']
                rt=os.environ.copy();rt.update(SFU_ANNOUNCED_IP=config['nodes']['sfu'],SFU_PUBLIC_URL='https://sfu.hallerbans.de')
                run(['bash','scripts/hetzner/wire-rtc.sh','sfu'],env=rt)
            elif role=='app':
                caddy=(ROOT/'scripts/hetzner/Caddyfile.dns01').read_text().split('# SFU-TKnoten:')[0]
                (ROOT/'Caddyfile').write_text(caddy)
                rt=os.environ.copy();rt.update(SFU_PUBLIC_IP=config['nodes']['sfu'],SFU_PUBLIC_URL='https://sfu.hallerbans.de')
                run(['bash','scripts/hetzner/wire-rtc.sh','app'],env=rt)
            if role=='app' and (ROOT/'media/orchestral').is_dir():
                compose+=['-f','docker-compose.media.yml']
            if caddy_override is not None:
                compose += ['-f', str(caddy_override)]
            publish('building')
            run(compose+['build','--build-arg','BUILD_COMMIT='+config['commit'],'audiomonastry'],timeout=2400)
            if role=='app':run(compose+['build','master-player'],timeout=1200)
            services={'app':['caddy','audiomonastry','master-player'],'sfu':['caddy','audiomonastry','coturn'],'media':['audiomonastry']}[role]
            run(compose+['up','-d','--no-build']+services)
        publish('testing')
        current=env_read()
        if role!='edge':
            for attempt in range(60):
                try:
                    req=urllib.request.Request('http://127.0.0.1:8080/api/health',headers={'x-studio-token':current['STUDIO_ACCESS_TOKEN']})
                    with urllib.request.urlopen(req,timeout=10) as response: health=json.load(response)
                    if health.get('status')=='ok':break
                except (urllib.error.URLError,OSError,ValueError):pass
                time.sleep(5)
            else:raise RuntimeError('HEALTH_NOT_READY')
            report['checks']['apiHealth']=True
            report['checks']['buildCommitMatches']=health.get('commit')==config['commit'] or health.get('build',{}).get('commit')==config['commit']
        ps=subprocess.run(['docker','ps','--format','{{.Names}} {{.Status}}'],capture_output=True,text=True)
        report['containers']=ps.stdout.splitlines()
        timer=subprocess.run(['systemctl','is-active','audiomonastry-idle-shutdown.timer'],capture_output=True,text=True)
        report['checks']['idleTimerActive']=timer.returncode==0
        report['checks']['supabaseConfigured']=bool(url and anon)
        report['checks']['r2Authenticated']=True
        publish('services_started')
    except Exception as exc:
        # Export a fixed category only. Detailed output remains root-only.
        report['failureFrames']=[{'function':f.name,'line':f.lineno} for f in traceback.extract_tb(exc.__traceback__) if f.filename.endswith('audiomonastry-production.py')]
        report['errorCode']=str(exc) if str(exc) in ('COMMAND_FAILED','HEALTH_NOT_READY','REGISTRY_LOGIN_FAILED','STUDIO_AUTH_MISSING','SUPABASE_URL_INVALID') else type(exc).__name__
        try:publish('failed')
        except Exception:pass
        raise
    finally:
        Path('/root/audiomonastry-production.json').unlink(missing_ok=True)

if __name__=='__main__':
    main()
