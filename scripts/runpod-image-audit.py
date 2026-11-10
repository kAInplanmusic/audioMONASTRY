#!/usr/bin/env python3
"""Check selected-model imports and dispatch in an actual built image; no inference."""
import importlib
import json
import os
from pathlib import Path
import sys

# Upstream checkouts are deliberately not pip packages in the runtime image.
sys.path[:0] = [os.environ.get('MOSS_SFX_ROOT', '/opt/moss-tts'), '/opt/acestep']
import handlers

REQUIRED = {
    'qwen38-27b-fp8': ['vllm'],
    'yue2-3b': ['yue2'],
    'universr': ['universr'],
    'acestep-v15-xl-base': ['acestep.handler', 'acestep.inference'],
    'acestep-v15-xl-turbo': ['acestep.handler', 'acestep.inference'],
    'acestep-v15-shared': ['acestep.handler', 'acestep.inference'],
    'acestep-5hz-lm-4b': ['acestep.handler', 'acestep.inference'],
    'moss-soundeffect-v2.0': ['moss_soundeffect_v2'],
    'beat-this': ['beat_this.inference'],
    'basic-pitch': ['onnxruntime', 'basic_pitch.constants'],
    'qwen3-tts-17b': ['qwen_tts'],
    'qwen3-tts-voicedesign': ['qwen_tts'],
}

def main():
    manifest = json.loads(Path('model_manifest.json').read_text())
    imports = {}
    rows = []
    for model in manifest['models']:
        modules = REQUIRED.get(model['id'], [])
        for name in modules:
            if name not in imports:
                try:
                    importlib.import_module(name)
                    imports[name] = {'available': True}
                except Exception as exc:
                    imports[name] = {'available': False, 'errorType': type(exc).__name__,
                                     'error': str(exc)[:300]}
        task = handlers._normalize_task(model['task'])
        rows.append({'model': model['id'], 'task': task,
                     'dispatchRegistered': task in handlers.HANDLERS,
                     'checkedImports': {name: imports[name] for name in modules}})
    report = {'scope': 'CPU import and task registration only; not GPU/model-load/audio validation',
              'models': rows, 'modelCount': len(rows),
              'passed': all(r['dispatchRegistered'] and all(x['available'] for x in r['checkedImports'].values()) for r in rows)}
    Path(os.environ.get('IMAGE_AUDIT_OUT', '/tmp/image-audit.json')).write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))
    return 0 if report['passed'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
