import base64
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('appsnap', ROOT / 'scripts/hetzner/app-from-snapshot.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class UserDataTests(unittest.TestCase):
    def test_cloud_init_carries_env_ca_and_apply_script_and_no_account_keys(self):
        data = mod.build_user_data('AI_POD_TOKEN=t\nVAST_POD_URL_BRAIN=https://h:1\n', 'CA-PEM')
        blobs = [l.split('content: ')[1] for l in data.splitlines() if 'content: ' in l]
        self.assertEqual('CA-PEM', base64.b64decode(blobs[0]).decode())
        self.assertIn('VAST_POD_URL_BRAIN', base64.b64decode(blobs[1]).decode())
        self.assertIn('/opt/audiomonastry/vast-ca/ca.pem', data)
        for word in ('VAST_API_KEY', 'HCLOUD', 'GHCR_PASSWORD', 'SECRET_ACCESS'):
            self.assertNotIn(word, data)
        self.assertLess(len(data.encode()), 32 * 1024)

    def test_apply_script_merges_instead_of_replacing_the_env_and_recreates_only_the_app(self):
        script = mod.APPLY
        self.assertIn("kept = [l for l in open(env_path", script)                      # vorhandene fremde Schluessel bleiben
        self.assertIn("'--force-recreate', 'audiomonastry'", script)
        compile(script, 'apply', 'exec')

    def test_the_merge_keeps_unrelated_keys_and_replaces_pod_keys(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            env = Path(d) / '.env'
            env.write_text('KEEP=1\nAI_POD_TOKEN=old\n')
            (Path(d) / 'runtime.env').write_text('AI_POD_TOKEN=new\nVAST_POD_URL_X=https://h:1\n')
            code = mod.APPLY.replace('/opt/audiomonastry/.env', str(env)).replace('/root/vast-runtime.env', str(Path(d) / 'runtime.env')) \
                .replace("subprocess.run(['docker'", "(lambda *a, **k: None)(['docker'")
            exec(compile(code, 'apply', 'exec'), {})
            lines = env.read_text().splitlines()
        self.assertIn('KEEP=1', lines)
        self.assertIn('AI_POD_TOKEN=new', lines)
        self.assertNotIn('AI_POD_TOKEN=old', lines)
        self.assertIn('VAST_POD_URL_X=https://h:1', lines)


if __name__ == '__main__':
    unittest.main()
