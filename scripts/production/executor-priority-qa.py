"""Rent only the selected 4B executor, prove fifty commands, then delete it."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
from types import SimpleNamespace

root=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('priority_vast',root/'scripts/vast-pods.py')
vast=importlib.util.module_from_spec(spec);spec.loader.exec_module(vast)


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('plan','images','state-dir','output'):parser.add_argument('--'+name,required=True,type=Path)
    args=parser.parse_args()
    if (args.state_dir/'state.json').exists():raise RuntimeError('New private state required')
    report={'passed':False,'cleanupPassed':False,'acceptanceScope':'selected executor only',
            'sourceCommit':os.environ.get('GITHUB_SHA'),'runId':os.environ['GITHUB_RUN_ID']}
    def stop(signum,frame):raise SystemExit(128+signum)
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    try:
        code=vast.run(SimpleNamespace(command='up',yes=True,plan=args.plan,images=args.images,
            state_dir=args.state_dir,executor_only=True))
        state=json.loads((args.state_dir/'state.json').read_text())
        report['passed']=(code==0 and state.get('executorOnly') is True
            and state.get('allocationsEverCreated')==1 and set(state.get('instances',{}))=={'audio-brain'}
            and state.get('executorFunctionalPreflight',{}).get('passed') is True)
    except Exception as error:
        message=str(error)
        if message.startswith('Executor functional'):report['failureCode']='EXECUTOR_FUNCTIONAL_FAILED'
        elif message.startswith('Terminal instance status:'):report['failureCode']='PROVIDER_STARTUP_FAILED'
        elif message.startswith('Terminal model readiness failure:'):report['failureCode']='MODEL_STARTUP_FAILED'
        elif message.startswith('Readiness deadline exceeded:'):report['failureCode']='EXECUTOR_READINESS_DEADLINE'
        else:report['failureCode']=type(error).__name__
    finally:
        path=args.state_dir/'state.json'
        if path.exists():
            state=json.loads(path.read_text())
            report.update(allocationsEverCreated=state.get('allocationsEverCreated',0),
                allocatedInstances=state.get('allocationHistory',[]),
                executorStartupForecast=state.get('executorStartupForecast'),
                executorHardwareProof=state.get('executorFunctionalPreflight'),
                budgetEvidence={key:state[key] for key in ('quotedHourlyEur','coldStartUpperEur','observedAccountHourlyEur') if key in state})
        try:report['cleanupPassed']=vast.run(SimpleNamespace(command='down',yes=True,state_dir=args.state_dir))==0
        except Exception:report['cleanupPassed']=False
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report))
    return 0 if report['passed'] and report['cleanupPassed'] else 4


if __name__=='__main__':raise SystemExit(main())
