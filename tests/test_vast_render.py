"""Probe contracts and actual production auth; mocks never count as GPU proof."""
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'services/audiomonastry-ai-runtime'))
import render_probe


class RenderProbeTests(unittest.TestCase):
    def exercise(self, frames=24, encode_code=0):
        browser_api = MagicMock()
        browser_api.return_value.__enter__.return_value.chromium.launch.return_value.new_page.return_value.screenshot.return_value = b'\x89PNG\r\n\x1a\n' + b'frame'
        def command(args, **kwargs):
            if args[0] == 'ffmpeg':
                self.assertEqual('h264_nvenc',args[args.index('-c:v')+1])
                self.assertEqual(b'\x89PNG\r\n\x1a\nframe',Path(args[args.index('-i')+1]).read_bytes())
                Path(args[-1]).write_bytes(b'encoded' * 100)
                return SimpleNamespace(returncode=encode_code)
            return SimpleNamespace(returncode=0,stdout=json.dumps({'streams':[{'codec_name':'h264',
                'width':640,'height':360,'nb_frames':str(frames)}]}).encode())
        with patch('playwright.sync_api.sync_playwright',browser_api), patch.object(
                render_probe.subprocess,'run',side_effect=command):
            return render_probe.run()

    def test_chromium_frame_is_encoded_by_explicit_hardware_encoder(self):
        proof = self.exercise()
        self.assertTrue(proof['passed'])
        self.assertEqual(24,proof['frames'])
        self.assertEqual(64,len(proof['nvencMp4Sha256']))

    def test_failed_hardware_or_truncated_video_never_pass(self):
        with self.assertRaisesRegex(RuntimeError,'NVENC_ENCODE_FAILED'):
            self.exercise(encode_code=1)
        with self.assertRaisesRegex(RuntimeError,'NVENC_OUTPUT_INVALID'):
            self.exercise(frames=1)

    def test_diagnostic_inherits_real_runtime_auth_and_restricts_vis_role(self):
        import app as runtime
        import vast_app
        from fastapi.testclient import TestClient
        client = TestClient(vast_app.app)
        with patch.object(runtime,'POD_TOKEN','test-only-token'), patch.object(vast_app,'_proof',None), patch.object(
                vast_app.render_probe,'run',return_value={'passed':True}) as run, patch.dict(os.environ,{'AI_ROLE':'vis'}):
            self.assertEqual(401,client.get('/diagnostics/render').status_code)
            run.assert_not_called()
            headers = {'Authorization':'Bearer test-only-token'}
            self.assertEqual(200,client.get('/diagnostics/render',headers=headers).status_code)
            self.assertEqual(200,client.get('/diagnostics/render',headers=headers).status_code)
            run.assert_called_once()
            with patch.dict(os.environ,{'AI_ROLE':'brain'}):
                self.assertEqual(404,client.get('/diagnostics/render',headers=headers).status_code)


if __name__ == '__main__':
    unittest.main()
