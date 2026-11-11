"""Isolated QA-only serverless entrypoint; executes the production inference handler."""
import time
import traceback
import torch
import runpod
import registry
import runpod_worker as worker

ROLES = {
    'mvsep-mega-53': 'studio', 'mel-roformer-bve': 'studio',
    'mel-roformer-dereverb': 'vis', 'beat-this': 'ears', 'basic-pitch': 'ears',
    'qwen3-tts-17b': 'voiceGen', 'qwen3-tts-voicedesign': 'voiceGen', 'universr': 'vis',
}


def handler(job):
    model = job.get('input', {}).get('model')
    if model not in ROLES:
        return {'qaError': 'model outside the fixed QA selection'}
    if not torch.cuda.is_available():
        return {'qaError': 'CUDA unavailable; CPU fallback is not a GPU pass'}
    torch.cuda.reset_peak_memory_stats()
    worker.manager.configure(registry.load_manifest(ROLES[model]))
    start = time.monotonic()
    traces=[]
    original=worker.manager.infer
    def traced_infer(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        except Exception:
            traces.append(traceback.format_exc()[-6000:])
            raise
    worker.manager.infer=traced_infer
    try:
        output = worker.handler(job)
    finally:
        worker.manager.infer=original
    torch.cuda.synchronize()
    return {'qa': {'model': model, 'role': ROLES[model],
                   'gpu': torch.cuda.get_device_name(0), 'torch': torch.__version__,
                   'cudaRuntime': torch.version.cuda, 'cudaAvailable': True,
                   'peakAllocatedBytes': torch.cuda.max_memory_allocated(),
                   'peakReservedBytes': torch.cuda.max_memory_reserved(),
                   'errorTracebacks': traces, 'wallSeconds': round(time.monotonic()-start, 3)},
            'inference': output}


runpod.serverless.start({'handler': handler})
