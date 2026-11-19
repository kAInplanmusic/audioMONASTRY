import json, re, pathlib, subprocess
root = pathlib.Path(__file__).resolve().parents[2]; rt = root / 'services/audiomonastry-ai-runtime'
man = json.loads((rt / 'model_manifest.json').read_text()); models = {m['id']: m for m in (man['models'] if isinstance(man, dict) else man)}
fleet = json.loads((root / 'deploy/gpu/pod-fleet.json').read_text())
pods = fleet['pods'] if isinstance(fleet['pods'], list) else list(fleet['pods'].values())
fleet_model_pod = {mid: p['role'] for p in pods for mid in p['models']}
ts = (root / 'src/core/ai/orchestrator/podRouting.ts').read_text()
block = ts[ts.index('const MODEL_POD'):ts.index('};', ts.index('const MODEL_POD'))]
ts_model_pod = {k.strip("'\""): v for k, v in re.findall(r"['\"]?([\w.\-]+)['\"]?\s*:\s*'([\w-]+)'", block)}
types = (root / 'src/core/ai/orchestrator/types.ts').read_text()
aitask = re.findall(r"\|\s*'([\w.]+)'", types[types.index('export type AiTask ='):types.index(';', types.index('export type AiTask ='))])
handlers = re.findall(r'^\s*"([\w.]+)":', (rt / 'handlers.py').read_text()[(rt / 'handlers.py').read_text().index('HANDLERS = {'):], re.M)
handlers = handlers[:handlers.index('agent.orchestrate') + 1] if 'agent.orchestrate' in handlers else handlers
norm = lambda t: t.split('.', 1)[1] if t.startswith('audio.') else t
py_all = '\n'.join(p.read_text(errors='replace') for p in rt.glob('*.py'))
res = {
 'manifestModelsWithoutPod': sorted(set(models) - set(fleet_model_pod)),
 'podModelsNotInManifest': sorted(set(fleet_model_pod) - set(models)),
 'tsRoutingNotInManifest': sorted(set(ts_model_pod) - set(models)),
 'manifestModelsNotRoutedInTs': sorted(set(models) - set(ts_model_pod)),
 'tsRoutingDisagreesWithFleet': {m: {'ts': ts_model_pod[m], 'fleet': fleet_model_pod.get(m)} for m in ts_model_pod if fleet_model_pod.get(m) and ts_model_pod[m] != fleet_model_pod[m]},
 'appTasksWithoutRuntimeHandler': [t for t in aitask if norm(t) not in handlers],
 'runtimeHandlersNotSentByApp': [h for h in handlers if h not in {norm(t) for t in aitask}],
 'modelIdsNeverMentionedInRuntimeCode': [m for m in models if m not in py_all],
}
print(json.dumps(res, indent=1, ensure_ascii=False))
