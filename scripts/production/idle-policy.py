"""Install the authorized fifteen-minute policy without changing studio data."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess

ROOT=Path('/opt/audiomonastry')
spec=importlib.util.spec_from_file_location('bootstrap',ROOT/'scripts/production/bootstrap.py')
bootstrap=importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


def update_file(path, values):
    lines=path.read_text().splitlines() if path.exists() else []
    keys=set(values)
    lines=[line for line in lines if line.partition('=')[0].lstrip('# ').strip() not in keys]
    path.write_text('\n'.join(lines+[key+'='+value for key,value in values.items()])+'\n')
    path.chmod(0o600)


def main():
    os.umask(0o077)
    config=json.loads(Path('/root/audiomonastry-production.json').read_text())
    env=bootstrap.env_read()
    bootstrap.env_merge({'IDLE_SHUTDOWN_MINUTES':'15','IDLE_MINUTES':'15','AI_FLEET_AUTOSTOP_IDLE_MS':'900000'})
    timer_env=Path('/etc/audiomonastry/idle-check.env')
    if timer_env.exists():update_file(timer_env,{'IDLE_MINUTES':'15'})
    install_env=dict(os.environ,IDLE_MINUTES='15',CHECK_INTERVAL='0.25')
    bootstrap.run(['bash','scripts/hetzner/install-idle-shutdown.sh'],env=install_env)
    values={key:value for key,value in config['updates'].items() if key in
            ('HCLOUD_TOKEN','VAST_API_KEY','AI_POD_TOKEN','CFS3_ACCESS_KEY','CFS3_SECRET_KEY','CFS3_BUCKET','CFS3_ENDPOINT')}
    values['STUDIO_ACCESS_TOKEN']=env['STUDIO_ACCESS_TOKEN'].strip('"\'')
    values['FLEET_TEARDOWN_RUNNER_ROLE']=config['role']
    update_file(ROOT/'.env.deploy',values)
    if config['role'] != 'edge':
        metadata=json.loads(subprocess.check_output(['docker','inspect','audiomonastry']))[0]
        files=metadata['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
        command=['docker','compose']
        for file in files:
            if not Path(file).resolve().is_relative_to(ROOT):raise RuntimeError('UNEXPECTED_COMPOSE_PATH')
            command+=['-f',file]
        bootstrap.run(command+['up','-d','--no-build','audiomonastry'])
    if config['role'] in ('app','edge'):
        unit=Path('/etc/systemd/system/audiomonastry-production-idle.service')
        unit.write_text('[Unit]\nDescription=audioMONASTRY 15 minute complete fleet cleanup\nAfter=network-online.target\n[Service]\nType=oneshot\nWorkingDirectory=/opt/audiomonastry\nExecStart=/usr/bin/python3 /opt/audiomonastry/scripts/fleet-idle-teardown.py --apply --idle-minutes 15 --grace-minutes 15\nTimeoutStartSec=3600\n')
        timer=unit.with_suffix('.timer')
        timer.write_text('[Unit]\nDescription=audioMONASTRY idle watchdog\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=15s\nAccuracySec=1s\nUnit=audiomonastry-production-idle.service\n[Install]\nWantedBy=timers.target\n')
        bootstrap.run(['systemctl','daemon-reload'])
        bootstrap.run(['systemctl','enable','--now',timer.name])
    report={'role':config['role'],'stage':'passed','idleMinutes':15,'completeDeletionWatchdog':config['role'] in ('app','edge')}
    bootstrap.s3_request(config,'PUT',config['evidencePrefix']+'/idle-policy-'+config['role']+'.json',json.dumps(report).encode())
    Path('/root/audiomonastry-production.json').unlink(missing_ok=True)


if __name__=='__main__':main()
