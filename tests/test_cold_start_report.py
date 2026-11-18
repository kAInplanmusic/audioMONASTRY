"""Cold-start target rules (operator 2026-11-18): 15 min target, one slow role may use 15 more minutes, two or more late roles abort."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import cold_start_report as cs  # noqa: E402

POLICY = {'maxTestMinutes': 32, 'coldStartTargetMinutes': 15, 'coldStartGraceMinutes': 15}


class LimitsTests(unittest.TestCase):
    def test_repository_policy_encodes_the_operator_rule(self):
        policy = json.loads((ROOT / 'deploy/gpu-provider.json').read_text())
        target, hard = cs.limits_seconds(policy)
        self.assertEqual((15 * 60, 30 * 60), (target, hard))                     # 15 min Ziel, bis zu 15 min mehr fuer eine Rolle
        self.assertLessEqual(hard, (policy['maxTestMinutes'] - 2) * 60)          # zwei Minuten Aufraeumreserve bleiben

    def test_hard_limit_never_exceeds_the_window_and_never_undercuts_the_target(self):
        self.assertEqual((15 * 60.0, 30 * 60.0), cs.limits_seconds(POLICY))
        self.assertEqual((15 * 60.0, 26 * 60.0), cs.limits_seconds({**POLICY, 'maxTestMinutes': 28}))      # gedeckelt
        self.assertEqual((15 * 60.0, 15 * 60.0), cs.limits_seconds({'maxTestMinutes': 28, 'coldStartTargetMinutes': 15}))  # ohne Nachfrist
        self.assertEqual((26 * 60.0, 26 * 60.0), cs.limits_seconds({'maxTestMinutes': 28, 'coldStartTargetMinutes': 60}))


class DecisionTests(unittest.TestCase):
    soft, hard = 900.0, 1800.0

    def test_ready_when_nothing_is_pending(self):
        self.assertEqual('ready', cs.decision([], 5000, self.soft, self.hard))

    def test_waits_before_the_target(self):
        self.assertEqual('wait', cs.decision(['brain', 'ears'], 899.9, self.soft, self.hard))

    def test_one_late_role_gets_the_grace_period(self):
        self.assertEqual('grace', cs.decision(['brain'], 900.0, self.soft, self.hard))
        self.assertEqual('grace', cs.decision(['brain'], 1799.9, self.soft, self.hard))

    def test_two_or_more_late_roles_abort_at_the_target(self):
        self.assertEqual('abort_multiple', cs.decision(['brain', 'ears'], 900.0, self.soft, self.hard))
        self.assertEqual('abort_multiple', cs.decision(['a', 'b', 'c'], 1200.0, self.soft, self.hard))

    def test_hard_deadline_ends_the_grace(self):
        self.assertEqual('abort_hard', cs.decision(['brain'], 1800.0, self.soft, self.hard))
        self.assertEqual('abort_hard', cs.decision(['brain', 'ears'], 1800.0, self.soft, self.hard))   # hart gewinnt

    def test_without_a_soft_deadline_only_the_hard_one_counts(self):
        self.assertEqual('wait', cs.decision(['a', 'b'], 1000, None, self.hard))
        self.assertEqual('abort_hard', cs.decision(['a'], 1800, None, self.hard))


def state(ready, extra=None):
    instances = {role: {'gpu': 'RTX 4090', 'machineId': 1, 'downloadReported': 900.0} for role in ('brain', 'vis', 'ears')}
    return {'startedAt': 1000.0, 'instances': instances, 'readyAtSeconds': ready,
            'payloadGbByRole': {'brain': 39.4, 'vis': 4.5, 'ears': 26.4}, **(extra or {})}


class ReportTests(unittest.TestCase):
    def test_target_met_report_has_no_notice(self):
        report = cs.build_report(state({'brain': 600, 'vis': 300, 'ears': 840}), 2000.0, POLICY, 'ready')
        self.assertTrue(report['targetMet'])
        self.assertEqual([], report['rolesOverTarget'])
        self.assertNotIn('notice', report)
        self.assertNotIn('hints', report)

    def test_a_slow_role_produces_a_notice_with_measured_numbers_and_options(self):
        report = cs.build_report(state({'brain': 1500, 'vis': 300, 'ears': 840}), 3000.0, POLICY, 'ready after grace')
        self.assertFalse(report['targetMet'])
        self.assertEqual(['brain'], report['rolesOverTarget'])
        self.assertIn('nicht erreicht', report['notice'])
        text = '\n'.join(report['hints'])
        self.assertIn('brain: bereit nach 25.0 min', text)
        self.assertIn('Payload 39.4 GB', text)
        self.assertIn('ideal 5.8 min bei gemeldeten 900 Mbit/s', text)                 # 39,4 GB * 8000 / 900 / 60
        self.assertIn('deutlich langsamer als die gemeldete Bandbreite', text)         # gemessen 25 min gegen ideal 5,8 min
        self.assertIn('Optionen', text)

    def test_a_role_that_never_became_ready_is_over_target(self):
        report = cs.build_report(state({'vis': 300}), 3000.0, POLICY, 'failed: deadline')
        self.assertEqual(['brain', 'ears'], report['rolesOverTarget'])
        self.assertIsNone(report['roles']['brain']['readySeconds'])
        self.assertIn('brain: nicht bereit', '\n'.join(report['hints']))

    def test_an_early_unrelated_abort_is_not_reported_as_a_missed_target(self):
        report = cs.build_report(state({}), 1000.0 + 25, POLICY, 'failed: no_such_ask')       # 25 s nach dem Start
        self.assertEqual([], report['rolesOverTarget'])
        self.assertFalse(report['targetMet'])                       # nicht erreicht, aber nicht verfehlt
        self.assertNotIn('notice', report)

    def test_hints_can_be_switched_off_and_empty_deployments_never_count_as_met(self):
        self.assertNotIn('hints', cs.build_report(state({}), 3000.0, POLICY, 'x', hints_enabled=False))
        self.assertFalse(cs.build_report({'startedAt': 0, 'instances': {}}, 1.0, POLICY, 'x')['targetMet'])

    def test_missing_numbers_never_break_the_hints(self):
        lines = cs.hints_for('x', {'readySeconds': None, 'payloadGb': None, 'downloadReported': None}, 15)
        self.assertEqual('x: nicht bereit (Ziel 15 min)', lines[0])

    def test_markdown_block_lists_every_role_and_the_notice(self):
        report = cs.build_report(state({'brain': 1500, 'vis': 300, 'ears': 840}), 3000.0, POLICY, 'ready after grace')
        block = cs.to_markdown(report, '2026-11-18 15:00')
        self.assertIn('Ziel NICHT erreicht', block)
        for role in ('brain', 'vis', 'ears'):
            self.assertIn('| %s |' % role, block)
        self.assertIn('**Hinweis:**', block)
        self.assertEqual(report, json.loads(cs.dump(report)))


if __name__ == '__main__':
    unittest.main()


class LogAppendTests(unittest.TestCase):
    def load(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('csr_cli', ROOT / 'scripts/cold-start-report.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_entries_are_appended_never_overwritten_and_keep_the_notice(self):
        import tempfile
        cli = self.load()
        first = cs.build_report(state({'brain': 600, 'vis': 300, 'ears': 840}), 2000.0, POLICY, 'ready')
        second = cs.build_report(state({'brain': 1500, 'vis': 300, 'ears': 840}), 3000.0, POLICY, 'ready after grace')
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / 'COLD_START_LOG.md'
            cli.append(first, log, '2026-11-18 10:00')
            cli.append(second, log, '2026-11-18 11:00')
            text = log.read_text(encoding='utf-8')
        self.assertTrue(text.startswith('# Kaltstart-Log'))
        self.assertLess(text.index('2026-11-18 10:00'), text.index('2026-11-18 11:00'))
        self.assertEqual(1, text.count('**Hinweis:**'))                 # nur der zweite Lauf verfehlte das Ziel
        self.assertIn('Ziel erreicht', text)
        self.assertIn('Ziel NICHT erreicht', text)


class WaitReadyIntegrationTests(unittest.TestCase):
    """Real wait_ready() with a fake clock and stubbed provider: grace for ONE late role, abort for two, report always written."""

    def load(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('vast_pods_cs', ROOT / 'scripts/vast-pods.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def run_scenario(self, ready_times, tmp):
        vast = self.load()
        clock = {'now': 1000.0}
        state = {'startedAt': 1000.0, 'instances': {r: {'id': i, 'host': 'h', 'cert': str(tmp / 'c.pem'), 'gpu': 'RTX 4090',
                                                          'machineId': i, 'downloadReported': 900.0}
                                                      for i, r in enumerate(ready_times)},
                 'payloadGbByRole': {r: 10.0 for r in ready_times}}
        vast.time.time = lambda: clock['now']
        vast.time.sleep = lambda s: clock.__setitem__('now', clock['now'] + 60)       # eine Minute je Durchlauf
        vast.provider_failure = lambda inst: None
        vast.fail_on_terminal_instance = lambda inst, role: None
        vast.enforce_vis_encoder = lambda *a, **k: None
        vast.private_write = lambda path, value: Path(path).write_text(value)

        class Resp:
            status = 200

            def __init__(self, body): self.body = body
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return json.dumps(self.body).encode()

        # Bereitschaft je Rolle zeitgesteuert: wir ersetzen die Netzpruefung ueber die Instanzliste (kein Port => nicht bereit)
        def live():
            minutes = (clock['now'] - 1000.0) / 60.0
            out = []
            for role, item in state['instances'].items():
                up = minutes >= ready_times[role]
                out.append({'id': str(item['id']), 'ports': {'8000/tcp': [{'HostPort': 1}]} if up else {}})
            return out
        vast.instances = live
        vast.ssl.create_default_context = lambda cafile=None: None
        vast.urllib.request.urlopen = lambda req, context=None, timeout=0: Resp({'models': []})
        (tmp / 'c.pem').write_text('x')
        models = {}
        expected = {r: [] for r in ready_times}
        policy = json.loads((ROOT / 'deploy/gpu-provider.json').read_text())
        soft, hard = vast.cold_start_deadlines(state, policy)
        import os
        os.environ.setdefault('VAST_API_KEY', 'x')
        try:
            code = vast.wait_ready(state, tmp, tmp / 's.json', 't', models, expected, {r: 1 for r in ready_times}, hard,
                                   soft_deadline=soft)
            err = None
        except RuntimeError as exc:
            code, err = None, str(exc)
        report = json.loads((tmp / 'cold-start-report.json').read_text())
        return code, err, report

    def test_all_roles_within_target_write_a_clean_report(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            code, err, report = self.run_scenario({'a': 3, 'b': 12}, Path(d))
        self.assertEqual(0, code)
        self.assertTrue(report['targetMet'])
        self.assertNotIn('notice', report)

    def test_one_late_role_gets_grace_and_a_notice(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            code, err, report = self.run_scenario({'a': 3, 'b': 22}, Path(d))
        self.assertEqual(0, code)
        self.assertEqual(['b'], report['rolesOverTarget'])
        self.assertIn('notice', report)

    def test_two_late_roles_abort_at_the_target(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            code, err, report = self.run_scenario({'a': 3, 'b': 20, 'c': 25}, Path(d))
        self.assertIsNone(code)
        self.assertIn('abort_multiple', err)
        self.assertEqual(['b', 'c'], report['rolesOverTarget'])
        self.assertLessEqual(report['elapsedMinutes'], 16)

    def test_a_single_role_beyond_the_hard_limit_is_aborted(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            code, err, report = self.run_scenario({'a': 3, 'b': 45}, Path(d))
        self.assertIn('abort_hard', err)
        self.assertLessEqual(report['elapsedMinutes'], 31)
