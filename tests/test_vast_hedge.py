"""Zweit-Host je Rolle (Betreiber 2026-11-18): Standard AUS, eigener Kostenwaechter, Gewinner wird behalten, Verlierer zerstoert."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('vast_hedge', ROOT / 'scripts/vast-pods.py')
vast = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vast)
import vast_transfer_budget as budget  # noqa: E402

PLAN = {'budget': {'usdToEur': 0.92, 'taxMultiplier': 1.19}, 'coldStartEvidence': {}}
POLICY = {'maxTotalEurPerHour': 8}


class EnvTests(unittest.TestCase):
    def test_hedging_is_off_by_default_and_parses_all_or_a_role_list(self):
        roles = ['brain', 'voice', 'vis']
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('VAST_HEDGE_ROLES', None)
            self.assertEqual([], vast.hedged_roles(roles))
        with patch.dict(os.environ, {'VAST_HEDGE_ROLES': 'all'}):
            self.assertEqual(roles, vast.hedged_roles(roles))
        with patch.dict(os.environ, {'VAST_HEDGE_ROLES': ' Voice , brain,unknown '}):
            self.assertEqual(['brain', 'voice'], vast.hedged_roles(roles))

    def test_window_is_bounded(self):
        with patch.dict(os.environ, {'VAST_HEDGE_WINDOW_MINUTES': '0'}):
            with self.assertRaises(RuntimeError):
                vast.hedge_window_minutes()
        with patch.dict(os.environ, {'VAST_HEDGE_WINDOW_MINUTES': '31'}):
            with self.assertRaises(RuntimeError):
                vast.hedge_window_minutes()
        with patch.dict(os.environ, {'VAST_HEDGE_WINDOW_MINUTES': '10'}):
            self.assertEqual(10.0, vast.hedge_window_minutes())


class RentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        for name in ('c.pem', 'k.pem'):
            (self.dir / name).write_text('x')
        self.state = {'instances': {'voice': {'id': 1, 'machineId': 10}}, 'pendingLabels': ['audiomonastry-vast-voice-1'],
                      'allocationsEverCreated': 1, 'quotedHourlyEur': 5.0, 'coldStartUpperEur': 0.9}
        self.choice = {'roles': {'voice': {'machineId': 10}}}
        self.bodies = {'voice': ({'label': 'audiomonastry-vast-voice-1', 'image': 'img', 'env': {'A': '1'}}, 'h1', 'c', 5)}
        self.prepared = {'voice': ({'role': 'voice'},)}
        self.quote = {'machineId': 20, 'gpu': 'g', 'usdPerHourIncludingDisk': 0.8, 'ingressUsdPerGb': 0.004, 'egressUsdPerGb': 0.004,
                      'downloadReported': 1000.0, 'grossEurPerHourIncludingDisk': 0.9}
        self.api_calls = []

    def run_rent(self, quote=None, fresh=None, api_error=None, policy=POLICY):
        def fake_api(method, path, body=None):
            self.api_calls.append((method, path, body))
            if api_error:
                raise RuntimeError(api_error)
            return {'success': True, 'new_contract': 77}

        fresh_result = fresh if fresh is not None else ({'id': 99, 'public_ipaddr': 'h2'}, quote or self.quote)
        with patch.object(budget, 'payloads', return_value={'voice': 10.0}), \
                patch.object(vast, 'fresh_offer', side_effect=(lambda *a, **k: fresh_result) if not isinstance(fresh_result, Exception) else fresh_result), \
                patch.object(vast, 'api', side_effect=fake_api), patch.object(vast, 'private_write', side_effect=lambda p, v: None), \
                patch.object(vast.time, 'sleep', lambda s: None):
            return vast.rent_hedges(self.state, self.dir / 's.json', self.dir, ['voice'], self.bodies, self.prepared, {}, {}, PLAN, {},
                                    self.choice, policy, '1', certificate_fn=lambda d, role, host: (self.dir / 'c.pem', self.dir / 'k.pem'))

    def test_a_second_host_on_another_machine_is_recorded_and_owned_by_label(self):
        with patch.dict(os.environ, {'VAST_HEDGE_WINDOW_MINUTES': '15'}):
            hedges = self.run_rent()
        self.assertEqual(77, hedges['voice']['id'])
        self.assertEqual(20, hedges['voice']['machineId'])
        label = hedges['voice']['label']
        self.assertEqual('audiomonastry-vast-voice-hedge-1', label)
        self.assertIn(label, self.state['pendingLabels'])                    # `down` findet auch einen unklaren Kauf
        self.assertEqual(2, self.state['allocationsEverCreated'])
        method, path, body = self.api_calls[0]
        self.assertEqual(('PUT', '/api/v0/asks/99/'), (method, path))
        self.assertEqual(label, body['label'])
        self.assertIn('VAST_TLS_CERT_B64', body['env'])
        self.assertNotIn('VAST_TLS_CERT_B64', self.bodies['voice'][0]['env'])   # Primaer-Body unveraendert

    def test_the_first_hour_budget_guard_skips_an_unaffordable_second_host(self):
        tight = {'maxTotalEurPerHour': 6.0}                                  # 5.0 + 0.9 + Zweit-Host >= 6.0
        hedges = self.run_rent(policy=tight)
        self.assertEqual({}, hedges)
        self.assertEqual([], self.api_calls)                                 # nichts gemietet

    def test_unavailable_offer_or_no_alternative_never_aborts_the_run(self):
        self.assertEqual({}, self.run_rent(api_error='Vast API HTTP 400: no_such_ask'))
        self.state['hedges'] = {}
        self.assertEqual({}, self.run_rent(fresh=RuntimeError('Selected offer no longer available: voice')))


class WaitReadyHedgeTests(unittest.TestCase):
    """Echte wait_ready() mit gesteuertem probe_role: Gewinner bleibt, Verlierer wird zerstoert."""

    def run_scenario(self, primary, hedge):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        d = Path(tmp.name)
        (d / 'c.pem').write_text('x')
        state = {'startedAt': 1000.0, 'instances': {'voice': {'id': 1, 'host': 'h1', 'cert': str(d / 'c.pem'), 'machineId': 10}},
                 'hedges': {'voice': {'id': 2, 'host': 'h2', 'cert': str(d / 'c.pem'), 'machineId': 20}}}
        clock = {'now': 1000.0}
        destroyed = []
        script = {1: list(primary), 2: list(hedge)}

        def fake_probe(item, role, live, token, models, expected, grace):
            step = script[item['id']].pop(0) if len(script[item['id']]) > 1 else script[item['id']][0]
            if isinstance(step, Exception):
                raise step
            if step:
                item['url'] = 'https://' + item['host']
            return step

        with patch.object(vast, 'probe_role', side_effect=fake_probe), patch.object(vast, 'instances', return_value=[]), \
                patch.object(vast, 'destroy', side_effect=lambda ident: destroyed.append(ident)), \
                patch.object(vast, 'enforce_vis_encoder', lambda *a, **k: None), \
                patch.object(vast, 'private_write', side_effect=lambda p, v: Path(p).write_text(v)), \
                patch.object(vast.time, 'time', lambda: clock['now']), \
                patch.object(vast.time, 'sleep', lambda s: clock.__setitem__('now', clock['now'] + 60)), \
                patch.dict(os.environ, {'VAST_API_KEY': 'x'}):
            try:
                code = vast.wait_ready(state, d, d / 's.json', 't', {}, {'voice': []}, {'voice': 1}, 1000.0 + 1800, soft_deadline=1000.0 + 900)
                error = None
            except RuntimeError as exc:
                code, error = None, str(exc)
        return state, destroyed, code, error

    def test_primary_ready_first_destroys_the_second_host(self):
        state, destroyed, code, error = self.run_scenario([False, True], [False])
        self.assertEqual(0, code)
        self.assertEqual([2], destroyed)
        self.assertEqual(1, state['instances']['voice']['id'])
        self.assertEqual({}, state['hedges'])
        self.assertEqual('primary', state['hedgeResults']['voice'])

    def test_second_host_ready_first_replaces_the_primary_and_destroys_it(self):
        state, destroyed, code, error = self.run_scenario([False], [False, True])
        self.assertEqual(0, code)
        self.assertEqual([1], destroyed)
        self.assertEqual(2, state['instances']['voice']['id'])
        self.assertEqual(20, state['instances']['voice']['machineId'])
        self.assertEqual('hedge', state['hedgeResults']['voice'])

    def test_a_dead_primary_hands_over_to_the_second_host(self):
        state, destroyed, code, error = self.run_scenario([RuntimeError('Terminal instance status: voice provider-exited')], [False, True])
        self.assertEqual(0, code)
        self.assertEqual([1], destroyed)
        self.assertEqual(2, state['instances']['voice']['id'])

    def test_a_dead_second_host_is_dropped_without_touching_the_primary(self):
        state, destroyed, code, error = self.run_scenario([False, False, True], [RuntimeError('provider-exited')])
        self.assertEqual(0, code)
        self.assertEqual([2], destroyed)
        self.assertEqual(1, state['instances']['voice']['id'])
        self.assertEqual({}, state['hedges'])

    def test_without_a_second_host_a_dead_primary_still_aborts_as_before(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        d = Path(tmp.name)
        (d / 'c.pem').write_text('x')
        state = {'startedAt': 1000.0, 'instances': {'voice': {'id': 1, 'host': 'h1', 'cert': str(d / 'c.pem')}}}
        with patch.object(vast, 'probe_role', side_effect=RuntimeError('Terminal instance status: voice provider-exited')), \
                patch.object(vast, 'instances', return_value=[]), patch.object(vast, 'private_write', lambda p, v: None), \
                patch.object(vast.time, 'time', lambda: 1000.0):
            with self.assertRaisesRegex(RuntimeError, 'Terminal instance status'):
                vast.wait_ready(state, d, d / 's.json', 't', {}, {'voice': []}, {'voice': 1}, 2800.0, soft_deadline=1900.0)


class DownCoversHedgesTests(unittest.TestCase):
    def test_down_destroys_second_hosts_too_and_clears_them(self):
        import argparse
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            prefix = vast.PREFIX
            state = {'instances': {'voice': {'id': 1, 'label': prefix + 'voice-9'}},
                     'hedges': {'voice': {'id': 2, 'label': prefix + 'voice-hedge-9'}},
                     'pendingLabels': [prefix + 'voice-9', prefix + 'voice-hedge-9']}
            (d / 'state.json').write_text(json.dumps(state))
            live = {'1': {'id': 1, 'label': prefix + 'voice-9'}, '2': {'id': 2, 'label': prefix + 'voice-hedge-9'}}
            destroyed = []

            def fake_instances():
                return [row for ident, row in live.items() if ident not in destroyed]

            with patch.object(vast, 'instances', side_effect=fake_instances), \
                    patch.object(vast, 'destroy', side_effect=lambda ident: destroyed.append(str(ident))), \
                    patch.dict(os.environ, {'VAST_API_KEY': 'x'}):
                vast.run(argparse.Namespace(command='down', yes=True, state_dir=d))
            self.assertEqual({'1', '2'}, set(destroyed))
            after = json.loads((d / 'state.json').read_text())
            self.assertEqual({}, after['instances'])
            self.assertEqual({}, after['hedges'])


if __name__ == '__main__':
    unittest.main()
