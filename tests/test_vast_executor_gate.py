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


class ColdStartTargetTests(unittest.TestCase):
    def test_the_operator_target_is_fifteen_minutes_and_inside_the_cost_window(self):
        policy = json.loads((ROOT / 'deploy/gpu-provider.json').read_text())
        self.assertEqual(15, policy['coldStartTargetMinutes'])                 # Betreiber 2026-11-18: App in < 15 min
        self.assertEqual(15.0, budget.cold_start_target_minutes())
        self.assertLessEqual(policy['coldStartTargetMinutes'], policy['maxTestMinutes'] - 2)

    def test_the_target_never_exceeds_the_window_minus_cleanup_reserve(self):
        self.assertEqual(15.0, budget.cold_start_target_minutes({'maxTestMinutes': 28, 'coldStartTargetMinutes': 15}))
        self.assertEqual(26.0, budget.cold_start_target_minutes({'maxTestMinutes': 28, 'coldStartTargetMinutes': 60}))
        self.assertEqual(26.0, budget.cold_start_target_minutes({'maxTestMinutes': 28}))        # ohne Vorgabe: altes Verhalten

    def test_readiness_deadline_uses_the_target_not_the_whole_window(self):
        spec2 = importlib.util.spec_from_file_location('vast_gate', ROOT / 'scripts/vast-pods.py')
        vast = importlib.util.module_from_spec(spec2)
        spec2.loader.exec_module(vast)
        policy = json.loads((ROOT / 'deploy/gpu-provider.json').read_text())
        self.assertEqual(1000 + 15 * 60, vast.cold_start_deadline({'startedAt': 1000}, policy))
        self.assertLess(budget.executor_startup_minutes({}), budget.cold_start_target_minutes())    # Pod 1 vor dem Gesamtziel
        with self.assertRaises(RuntimeError):
            budget.executor_startup_minutes({'VAST_EXECUTOR_STARTUP_MINUTES': '16'})                  # nicht ueber dem 15-min-Ziel


class ExecutorGateTests(unittest.TestCase):
    def test_default_is_eight_minutes_without_override(self):
        self.assertEqual(8, budget.executor_startup_minutes({}))
        self.assertEqual(8, budget.DEFAULT_EXECUTOR_STARTUP_MINUTES)

    def test_override_is_accepted_only_inside_the_cost_window(self):
        self.assertEqual(2.0, budget.executor_startup_minutes({'VAST_EXECUTOR_STARTUP_MINUTES': '2'}))
        self.assertEqual(15.0, budget.executor_startup_minutes({'VAST_EXECUTOR_STARTUP_MINUTES': '15'}))     # genau das Ziel ist erlaubt
        for bad in ('1.9', '15.1', str(MAX_TEST - 1), str(MAX_TEST), '999', '-5', 'nan', 'inf', 'abc', ''):
            with self.assertRaises(RuntimeError, msg=bad):
                budget.executor_startup_minutes({'VAST_EXECUTOR_STARTUP_MINUTES': bad})

    def test_observation_mode_stops_after_the_priority_pod_and_is_explicit(self):
        source = (ROOT / 'scripts/vast-pods.py').read_text()
        self.assertIn("os.environ.get('VAST_OBSERVE_EXECUTOR_TIMELINE') == '1'", source)
        i = source.index("VAST_OBSERVE_EXECUTOR_TIMELINE")
        self.assertIn('return 0', source[i:i + 500])
        self.assertIn("'remainingRolesNotYetRented'", source[:i])      # greift erst, nachdem der Pod bereit war




class ParallelGateModeTests(unittest.TestCase):
    def test_parallel_mode_is_an_explicit_opt_in_and_the_default_keeps_the_gate(self):
        text = (ROOT / 'scripts/vast-pods.py').read_text()
        self.assertIn("os.environ.get('VAST_EXECUTOR_GATE') == 'parallel'", text)
        # Standardpfad bleibt das Gate vor den uebrigen Mieten
        self.assertIn("elif role=='audio-brain':\n                verify_executor_before_other_rentals(", text)


if __name__ == '__main__':
    unittest.main()
