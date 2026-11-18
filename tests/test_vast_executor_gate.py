"""Executor readiness gate: default stays 8 minutes; the measured cold start needs an explicit, bounded override."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('budget_gate', ROOT / 'scripts/vast_transfer_budget.py')
budget = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget)
MAX_TEST = json.loads((ROOT / 'deploy/gpu-provider.json').read_text())['maxTestMinutes']


class TestWindowTests(unittest.TestCase):
    def test_default_window_is_the_policy_value_and_override_is_bounded(self):
        self.assertEqual(MAX_TEST, budget.test_window_minutes({}))
        self.assertEqual(float(MAX_TEST), budget.test_window_minutes({'VAST_TEST_WINDOW_MINUTES': str(MAX_TEST)}))
        self.assertEqual(60.0, budget.test_window_minutes({'VAST_TEST_WINDOW_MINUTES': '60'}))
        self.assertEqual(float(budget.MAX_TEST_WINDOW_MINUTES), budget.test_window_minutes({'VAST_TEST_WINDOW_MINUTES': '90'}))
        for bad in (str(MAX_TEST - 1), '91', '1000', '0', '-1', 'nan', 'inf', 'abc', ''):
            with self.assertRaises(RuntimeError, msg=bad):
                budget.test_window_minutes({'VAST_TEST_WINDOW_MINUTES': bad})

    def test_a_longer_window_widens_the_executor_gate_limit_but_not_beyond(self):
        env = {'VAST_TEST_WINDOW_MINUTES': '60'}
        self.assertEqual(25.0, budget.executor_startup_minutes({**env, 'VAST_EXECUTOR_STARTUP_MINUTES': '25'}))
        self.assertEqual(58.0, budget.executor_startup_minutes({**env, 'VAST_EXECUTOR_STARTUP_MINUTES': '58'}))
        with self.assertRaises(RuntimeError):
            budget.executor_startup_minutes({**env, 'VAST_EXECUTOR_STARTUP_MINUTES': '59'})


class ExecutorGateTests(unittest.TestCase):
    def test_default_is_eight_minutes_without_override(self):
        self.assertEqual(8, budget.executor_startup_minutes({}))
        self.assertEqual(8, budget.DEFAULT_EXECUTOR_STARTUP_MINUTES)

    def test_override_is_accepted_only_inside_the_cost_window(self):
        self.assertEqual(2.0, budget.executor_startup_minutes({'VAST_EXECUTOR_STARTUP_MINUTES': '2'}))
        self.assertEqual(float(MAX_TEST - 2), budget.executor_startup_minutes({'VAST_EXECUTOR_STARTUP_MINUTES': str(MAX_TEST - 2)}))
        for bad in ('1.9', str(MAX_TEST - 1), str(MAX_TEST), '999', '-5', 'nan', 'inf', 'abc', ''):
            with self.assertRaises(RuntimeError, msg=bad):
                budget.executor_startup_minutes({'VAST_EXECUTOR_STARTUP_MINUTES': bad})

    def test_observation_mode_stops_after_the_priority_pod_and_is_explicit(self):
        source = (ROOT / 'scripts/vast-pods.py').read_text()
        self.assertIn("os.environ.get('VAST_OBSERVE_EXECUTOR_TIMELINE') == '1'", source)
        i = source.index("VAST_OBSERVE_EXECUTOR_TIMELINE")
        self.assertIn('return 0', source[i:i + 500])
        self.assertIn("'remainingRolesNotYetRented'", source[:i])      # greift erst, nachdem der Pod bereit war


if __name__ == '__main__':
    unittest.main()
