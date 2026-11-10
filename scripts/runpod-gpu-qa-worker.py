"""Isolated QA-only serverless entrypoint; executes the production inference handler."""
import time
import torch
import runpod
import registry
import runpod_worker as worker

ROLES = {
    'mvsep-mega-53': 'studio', 'mel-roformer-bve': 'studio',
    'mel-roformer-dereverb': 'vis', 'beat-this': 'ears', 'basic-pitch': 'ears',
    'qwen3-tts-17b': 'voiceGen', 'qwen3-tts-voicedesign': 'voiceGen',
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
    output = worker.handler(job)
    torch.cuda.synchronize()
    return {'qa': {'model': model, 'role': ROLES[model],
                   'gpu': torch.cuda.get_device_name(0), 'torch': torch.__version__,
                   'cudaRuntime': torch.version.cuda, 'cudaAvailable': True,
                   'peakAllocatedBytes': torch.cuda.max_memory_allocated(),
                   'peakReservedBytes': torch.cuda.max_memory_reserved(),
                   'wallSeconds': round(time.monotonic()-start, 3)},
            'inference': output}


runpod.serverless.start({'handler': handler})
