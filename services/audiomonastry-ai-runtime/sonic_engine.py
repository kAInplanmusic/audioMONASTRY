"""Persistent, isolated SonicMaster engine; line JSON protocol on stdout only."""
import contextlib
import json
import sys
import traceback


def serve():
    state = None
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                import numpy as np
                import soundfile as sf
                import torch
                import torchaudio
                import yaml
                from diffusers import AutoencoderOobleck
                from safetensors.torch import load_file
                sys.path.insert(0, '/opt/sonic')
                from model import TangoFlux
                if state is None:
                    with open('/opt/sonic/configs/tangoflux_config.yaml') as stream:
                        config = yaml.safe_load(stream)['model']
                    model = TangoFlux(config=config, text_encoder_dir=request['text'])
                    keys = model.load_state_dict(load_file(request['checkpoint']), strict=False)
                    unexpected = list(keys.unexpected_keys)
                    missing = [key for key in keys.missing_keys if not key.startswith('text_encoder.')]
                    if missing or unexpected:
                        raise RuntimeError('SonicMaster checkpoint/model keys differ: '+str((missing, unexpected))[:500])
                    model.to('cuda').eval()
                    vae = AutoencoderOobleck.from_pretrained(request['vae'], subfolder='vae', local_files_only=True).to('cuda').eval()
                    state = model, vae
                model, vae = state
                data, sr = sf.read(request['input'], dtype='float32', always_2d=True)
                x = torch.from_numpy(data.T)
                if x.shape[0] == 1:
                    x = x.repeat(2, 1)
                x = torchaudio.functional.resample(x[:2], sr, 44100)
                length = x.shape[-1]
                chunk, overlap = 30*44100, 10*44100
                decoded, carry = [], None
                with torch.inference_mode():
                    for start in range(0, length, chunk-overlap):
                        audio = torch.nn.functional.pad(x[:, start:start+chunk], (0, max(0, start+chunk-length)))
                        z = vae.encode(audio.unsqueeze(0).to('cuda')).latent_dist.mode().transpose(1, 2)
                        result = model.inference_flow(z, request['prompt'], audiocond_latents=carry,
                            num_inference_steps=request['steps'], guidance_scale=1.0, duration=30,
                            seed=0, disable_progress=True, num_samples_per_prompt=1, solver='Euler')
                        wav = vae.decode(result.transpose(2, 1)).sample.clamp(-1, 1)
                        carry = vae.encode(wav[:, :, -overlap:]).latent_dist.mode().transpose(1, 2)
                        decoded.append(wav.cpu())
                    final = decoded[0]
                    for current in decoded[1:]:
                        alpha = torch.linspace(1, 0, overlap).view(1, 1, -1)
                        blend = final[:, :, -overlap:]*alpha+current[:, :, :overlap]*(1-alpha)
                        final = torch.cat((final[:, :, :-overlap], blend, current[:, :, overlap:]), dim=-1)
                    output = final.squeeze(0).T.numpy()[:length]
                    if not np.isfinite(output).all():
                        raise RuntimeError('SonicMaster returned nonfinite samples')
                    sf.write(request['output'], output, 44100, subtype='FLOAT')
            print(json.dumps({'ok': True}), flush=True)
        except Exception as exc:
            print(json.dumps({'ok': False, 'error': type(exc).__name__+': '+str(exc)[:1200]}), flush=True)


if __name__ == '__main__':
    serve()
