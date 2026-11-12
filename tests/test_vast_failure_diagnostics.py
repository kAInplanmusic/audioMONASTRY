"""Retain useful failed-start evidence without exposing bootstrap secrets."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vast = load('vast_failure_diagnostics', 'scripts/vast-pods.py')
qa = load('vast_qa_diagnostics', 'scripts/vast-http-fleet-qa.py')


class FailureDiagnosticsTests(unittest.TestCase):
    def test_distinguishes_terminal_states_without_exporting_provider_text(self):
        for status in ('exited', 'unknown', 'offline'):
            with self.assertRaises(RuntimeError) as caught:
                vast.fail_on_terminal_instance({'actual_status': status,
                    'status_msg': 'private signed URL and token'}, 'voice')
            self.assertEqual('Terminal instance status: voice (' + status + ')', str(caught.exception))
        for status in ('running', 'loading', None, 'untrusted provider text'):
            vast.fail_on_terminal_instance({'actual_status': status}, 'voice')

    def test_summary_exports_only_known_roles_and_positive_integer_ids(self):
        recorded = {'voice': {'id': 123, 'machineId': 456, 'host': 'private-address',
                             'cert': '/private/cert', 'token': 'secret'},
                    'song': {'id': 'not-an-id', 'machineId': True},
                    'untrusted-role': {'id': 789}}
        self.assertEqual([{'role': 'voice', 'id': 123, 'machineId': 456}, {'role': 'song'}],
                         qa.allocation_summary(recorded))


if __name__ == '__main__':
    unittest.main()
