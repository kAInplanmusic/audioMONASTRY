"""Snapshot stop/resume for the Vast fleet; no provider access, no rentals."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('vast_snapshot', ROOT / 'scripts/vast-pods.py')
vast = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vast)

ROLES = ['brain', 'ears', 'voice', 'music', 'studio', 'audio-brain', 'song', 'vis']
TOKEN = 't' * 40


def recorded(images):
    return {role: {'id': 100 + i, 'label': 'audiomonastry-vast-' + role + '-1700000000',
                   'host': '203.0.113.' + str(i + 1), 'cert': 'c', 'image': images[role], 'eurPerHour': 0.5}
            for i, role in enumerate(ROLES)}


def live(items, status):
    return [{'id': item['id'], 'label': item['label'], 'intended_status': status,
             'actual_status': 'exited' if status == 'stopped' else 'running',
             'storage_total_cost': 0.01, 'disk_space': 150} for item in items.values()]


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        # These tests cover snapshot logic only; attestation has its own tests.
        patcher = patch('vast_image_attestation.verify')
        patcher.start()
        self.addCleanup(patcher.stop)
        self.images = json.loads((ROOT / 'deploy/vast/images.json').read_text())
        self.dir = tempfile.TemporaryDirectory()
        self.state_dir = Path(self.dir.name)
        self.state_path = self.state_dir / 'state.json'
        self.items = recorded(self.images)

    def tearDown(self):
        self.dir.cleanup()

    def write(self, **extra):
        state = {'instances': self.items, 'promoted': True, 'startedAt': 1,
                 'manifestSha256': hashlib.sha256(vast.shared.MANIFEST_PATH.read_bytes()).hexdigest(),
                 'tokenSha256': hashlib.sha256(TOKEN.encode()).hexdigest(), **extra}
        self.state_path.write_text(json.dumps(state))
        (self.state_dir / 'runtime.env').write_text('AI_GPU_PROVIDER=vast\n')

    def test_stop_keeps_instances_and_records_snapshot(self):
        self.write()
        with patch.object(vast, 'instances', side_effect=[live(self.items, 'running'), live(self.items, 'stopped')]), \
                patch.object(vast, 'set_instance_state') as change, patch.object(vast, 'destroy') as destroy:
            self.assertEqual(0, vast.run(SimpleNamespace(command='stop', yes=True, state_dir=self.state_dir)))
        self.assertEqual(8, change.call_count)
        self.assertTrue(all(call.args[1] == 'stopped' for call in change.call_args_list))
        destroy.assert_not_called()
        state = json.loads(self.state_path.read_text())
        self.assertEqual(8, len(state['instances']))
        self.assertTrue(state['snapshot'])
        self.assertFalse(state['promoted'])
        self.assertFalse((self.state_dir / 'runtime.env').exists())

    def test_stop_refuses_foreign_label(self):
        self.write()
        foreign = live(self.items, 'running')
        foreign[0]['label'] = 'someone-else'
        with patch.object(vast, 'instances', return_value=foreign), patch.object(vast, 'set_instance_state'):
            with self.assertRaisesRegex(RuntimeError, 'ownership'):
                vast.run(SimpleNamespace(command='stop', yes=True, state_dir=self.state_dir))

    def resume_args(self):
        return SimpleNamespace(command='resume', yes=True, state_dir=self.state_dir,
                               images=ROOT / 'deploy/vast/images.json')

    def test_resume_requires_snapshot(self):
        self.write()
        with self.assertRaisesRegex(RuntimeError, 'No complete stopped snapshot'):
            vast.run(self.resume_args())

    def test_resume_refuses_changed_token(self):
        self.write(snapshot={'stoppedAt': 1})
        with patch.dict(vast.os.environ, {'AI_POD_TOKEN': 'x' * 40}):
            with self.assertRaisesRegex(RuntimeError, 'AI_POD_TOKEN differs'):
                vast.run(self.resume_args())

    def test_resume_refuses_deleted_instance(self):
        self.write(snapshot={'stoppedAt': 1})
        stopped = live(self.items, 'stopped')[1:]
        with patch.dict(vast.os.environ, {'AI_POD_TOKEN': TOKEN}), \
                patch.object(vast, 'api', return_value={'balance': 5}), \
                patch.object(vast, 'instances', return_value=stopped), \
                patch.object(vast, 'set_instance_state') as change:
            with self.assertRaisesRegex(RuntimeError, 'use down \\+ up'):
                vast.run(self.resume_args())
        change.assert_not_called()

    def test_resume_starts_all_roles_executor_first_and_clears_snapshot(self):
        self.write(snapshot={'stoppedAt': 1})
        with patch.dict(vast.os.environ, {'AI_POD_TOKEN': TOKEN}), \
                patch.object(vast, 'api', return_value={'balance': 5}), \
                patch.object(vast, 'instances', side_effect=[live(self.items, 'stopped'), live(self.items, 'running')]), \
                patch.object(vast, 'set_instance_state') as change, \
                patch.object(vast, 'wait_ready', return_value=0) as ready:
            self.assertEqual(0, vast.run(self.resume_args()))
        self.assertEqual(self.items['audio-brain']['id'], change.call_args_list[0].args[0])
        self.assertTrue(all(call.args[1] == 'running' for call in change.call_args_list))
        self.assertEqual(8, change.call_count)
        self.assertGreater(ready.call_args.kwargs['grace_until'], 0)
        self.assertIsNone(json.loads(self.state_path.read_text())['snapshot'])

    def test_failed_resume_stops_again_instead_of_deleting(self):
        self.write(snapshot={'stoppedAt': 1})
        with patch.dict(vast.os.environ, {'AI_POD_TOKEN': TOKEN}), \
                patch.object(vast, 'api', return_value={'balance': 5}), \
                patch.object(vast, 'instances', side_effect=[live(self.items, 'stopped'), live(self.items, 'running')]), \
                patch.object(vast, 'set_instance_state'), \
                patch.object(vast, 'wait_ready', side_effect=RuntimeError('Readiness deadline exceeded')), \
                patch.object(vast, 'snapshot_stop') as stop, patch.object(vast, 'destroy') as destroy:
            with self.assertRaisesRegex(RuntimeError, 'deadline'):
                vast.run(self.resume_args())
        stop.assert_called_once()
        destroy.assert_not_called()

    def test_resume_fails_fast_when_gpu_was_taken(self):
        self.write(snapshot={'stoppedAt': 1})
        with patch.dict(vast.os.environ, {'AI_POD_TOKEN': TOKEN}), \
                patch.object(vast, 'RESUME_SCHEDULING_SECONDS', 0), \
                patch.object(vast, 'api', return_value={'balance': 5}), \
                patch.object(vast, 'instances', return_value=live(self.items, 'stopped')), \
                patch.object(vast, 'set_instance_state'), \
                patch.object(vast, 'wait_ready') as ready, \
                patch.object(vast, 'snapshot_stop') as stop, patch.object(vast, 'destroy') as destroy:
            with self.assertRaisesRegex(RuntimeError, 'GPU not regained'):
                vast.run(self.resume_args())
        ready.assert_not_called()
        stop.assert_called_once()
        destroy.assert_not_called()


if __name__ == '__main__':
    unittest.main()
