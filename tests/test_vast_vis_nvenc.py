"""vis host selection: NVENC-less hosts are excluded instead of silently falling back to the CPU encoder."""
import importlib.util
import io
import json
import os
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vast = load('vast_vis_nvenc', 'scripts/vast-pods.py')


def state_with(capabilities, machine_id=777):
    return {'instances': {'vis': {'id': 1, 'machineId': machine_id, 'capabilities': capabilities},
                          'brain': {'id': 2, 'machineId': 5}}}


class BadHostTests(unittest.TestCase):
    def test_bad_hosts_persist_expire_and_deduplicate(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(set(), vast.load_bad_hosts(directory))
            vast.remember_bad_host(directory, 111, 'no nvenc', now=1000)
            vast.remember_bad_host(directory, 222, 'no nvenc', now=2000)
            vast.remember_bad_host(directory, 111, 'again', now=3000)           # gleicher Host: ein Eintrag
            rows = json.loads((Path(directory) / 'bad-hosts.json').read_text())
            self.assertEqual([222, 111], [row['machineId'] for row in rows])
            self.assertEqual({111, 222}, vast.load_bad_hosts(directory, now=4000))
            ttl = vast.BAD_HOSTS_TTL_SECONDS
            self.assertEqual({111}, vast.load_bad_hosts(directory, now=2000 + ttl + 1))   # 222 verfallen, 111 (3000) nicht
            self.assertEqual(set(), vast.load_bad_hosts(directory, now=3000 + ttl + 1))

    def test_unreadable_deny_list_is_treated_as_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'bad-hosts.json').write_text('not json')
            self.assertEqual(set(), vast.load_bad_hosts(directory))
            vast.remember_bad_host(directory, 5, 'x')                            # ueberschreibt die kaputte Datei
            self.assertEqual({5}, vast.load_bad_hosts(directory))


class EnforceEncoderTests(unittest.TestCase):
    def test_missing_nvenc_aborts_up_and_remembers_the_host(self):
        state = state_with({'nvenc': False, 'nvencReason': 'OpenEncodeSessionEx failed: unsupported device'})
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, 'no usable NVENC.*777.*run up again'):
                vast.enforce_vis_encoder(state, directory)
            self.assertEqual({777}, vast.load_bad_hosts(directory))

    def test_working_nvenc_unknown_capabilities_and_other_roles_do_not_abort(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            vast.enforce_vis_encoder(state_with({'nvenc': True}), directory)
            vast.enforce_vis_encoder(state_with(None), directory)                 # aelteres Image ohne Endpunkt
            vast.enforce_vis_encoder({'instances': {'brain': {'id': 2}}}, directory)   # keine vis-Rolle
            vast.enforce_vis_encoder({'instances': {}}, directory)
            self.assertEqual(set(), vast.load_bad_hosts(directory))

    def test_resume_and_warn_mode_only_warn(self):
        state = state_with({'nvenc': False, 'nvencReason': 'no device'})
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            out = io.StringIO()
            with redirect_stdout(out):
                vast.enforce_vis_encoder(state, directory, allow_fallback=True)    # resume: gleicher Host, kein Tausch
            self.assertIn('libx264', out.getvalue())
            with patch.dict(os.environ, {'VAST_VIS_NVENC': 'warn'}), redirect_stdout(io.StringIO()):
                vast.enforce_vis_encoder(state, directory)
            with patch.dict(os.environ, {'VAST_VIS_NVENC': 'off'}):
                vast.enforce_vis_encoder(state, directory)
            self.assertEqual(set(), vast.load_bad_hosts(directory))               # in diesen Modi wird nichts gesperrt


class FreshOfferDenyTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(vast.DENIED_MACHINES.clear)

    def offer(self, pod, selected, denied):
        vast.DENIED_MACHINES.clear()
        vast.DENIED_MACHINES.update({mid: 'vis' for mid in denied} if not isinstance(denied, dict) else denied)
        offers = [{'id': 1}, {'id': 2}]
        quotes = {1: {'machineId': 111, 'gpu': 'g', 'usdPerHourIncludingDisk': 0.1},
                  2: {'machineId': 222, 'gpu': 'g', 'usdPerHourIncludingDisk': 0.2}}
        with patch.object(vast.planner, 'query', return_value={}), \
                patch.object(vast.planner, 'search', return_value=offers) as search, \
                patch.object(vast.planner, 'candidate', side_effect=lambda offer, *a: quotes[offer['id']]):
            return vast.fresh_offer(pod, {}, {}, selected), search

    def test_denied_vis_host_is_replaced_by_another_unbought_host(self):
        (offer, quote), search = self.offer({'role': 'vis'}, {'machineId': 111, 'gpu': 'g'}, {111})
        self.assertEqual(222, quote['machineId'])
        self.assertEqual(1, search.call_count)                                  # nicht mehr gezielt auf den gesperrten Host gesucht
        self.assertNotIn('machine_id', search.call_args.args[0])

    def test_a_role_scoped_denial_does_not_affect_other_roles(self):
        (offer, quote), search = self.offer({'role': 'brain'}, {'machineId': 111, 'gpu': 'g'}, {111})
        self.assertEqual(111, quote['machineId'])
        self.assertEqual({'eq': 111}, search.call_args.args[0]['machine_id'])

    def test_an_unreachable_host_is_denied_for_every_role(self):
        for role in ('brain', 'voice', 'vis'):
            (offer, quote), search = self.offer({'role': role}, {'machineId': 111, 'gpu': 'g'}, {111: None})
            self.assertEqual(222, quote['machineId'], role)

    def test_without_any_alternative_the_purchase_still_fails_closed(self):
        vast.DENIED_MACHINES.update({111: 'vis', 222: 'vis'})
        offers = [{'id': 1}, {'id': 2}]
        with patch.object(vast.planner, 'query', return_value={}), patch.object(vast.planner, 'search', return_value=offers), \
                patch.object(vast.planner, 'candidate', side_effect=[{'machineId': 111, 'gpu': 'g', 'usdPerHourIncludingDisk': 0.1},
                                                                       {'machineId': 222, 'gpu': 'g', 'usdPerHourIncludingDisk': 0.2}]):
            with self.assertRaisesRegex(RuntimeError, 'no longer available'):
                vast.fresh_offer({'role': 'vis'}, {}, {}, {'machineId': 111, 'gpu': 'g'})


class UnreachableHostTests(unittest.TestCase):
    def test_listening_pod_with_failed_outside_connection_marks_the_host_for_all_roles(self):
        import tempfile
        log = 'INFO:     Application startup complete.\nINFO:     Uvicorn running on [url] (Press CTRL+C to quit)\n'
        with tempfile.TemporaryDirectory() as d, patch.object(vast, 'pod_log_text', return_value=log):
            self.assertTrue(vast.mark_unreachable_host(Path(d), {'id': 5, 'machineId': 142274}, 'audio-brain'))
            self.assertEqual({142274: None}, vast.denied_scopes(d))
            self.assertEqual({142274}, vast.load_bad_hosts(d, role='voice'))

    def test_a_pod_that_never_started_listening_is_not_blamed_on_the_host(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d, patch.object(vast, 'pod_log_text', return_value='downloading weights'):
            self.assertFalse(vast.mark_unreachable_host(Path(d), {'id': 5, 'machineId': 1}, 'brain'))
            self.assertEqual({}, vast.denied_scopes(d))
        with tempfile.TemporaryDirectory() as d, patch.object(vast, 'pod_log_text', return_value=None):
            self.assertFalse(vast.mark_unreachable_host(Path(d), {'id': 5, 'machineId': 1}, 'brain'))

    def test_legacy_rows_without_a_role_count_as_vis_only(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / 'bad-hosts.json').write_text(json.dumps([{'machineId': 9, 'reason': 'no nvenc', 'at': 1e12}]))
            self.assertEqual({9}, vast.load_bad_hosts(d, now=1e12 + 1, role='vis'))
            self.assertEqual(set(), vast.load_bad_hosts(d, now=1e12 + 1, role='brain'))


class ReplacementHostBoundsTests(unittest.TestCase):
    def test_replacement_must_meet_the_filter_and_is_ranked_by_the_given_key(self):
        offers = [{'id': 1}, {'id': 2}, {'id': 3}]
        quotes = {1: {'machineId': 111, 'gpu': 'g', 'usdPerHourIncludingDisk': 0.1, 'slow': True},
                  2: {'machineId': 222, 'gpu': 'g', 'usdPerHourIncludingDisk': 0.2, 'ingress': 5.0},
                  3: {'machineId': 333, 'gpu': 'g', 'usdPerHourIncludingDisk': 0.3, 'ingress': 0.0}}
        vast.DENIED_MACHINES.clear()
        self.addCleanup(vast.DENIED_MACHINES.clear)
        with patch.object(vast.planner, 'query', return_value={}), patch.object(vast.planner, 'search', return_value=offers), \
                patch.object(vast.planner, 'candidate', side_effect=lambda offer, *a: quotes[offer['id']]):
            offer, quote = vast.fresh_offer({'role': 'voice'}, {}, {}, {'machineId': 999, 'gpu': 'g'}, reserved=set(),
                                            accept=lambda q: not q.get('slow'),
                                            rank=lambda q: q['usdPerHourIncludingDisk'] + q.get('ingress', 0))
        self.assertEqual(333, quote['machineId'])            # 111 zu langsam, 222 durch Ingress teurer als 333

    def test_short_lived_denial_expires_after_its_ttl_while_others_last_longer(self):
        with tempfile.TemporaryDirectory() as d:
            vast.remember_bad_host(Path(d), 1, 'no_such_ask', now=1000, role='voice', ttl=1800)
            vast.remember_bad_host(Path(d), 2, 'unreachable', now=1000, role=None)
            self.assertEqual({1, 2}, vast.load_bad_hosts(Path(d), now=1000 + 1799))
            self.assertEqual({2}, vast.load_bad_hosts(Path(d), now=1000 + 1801))


if __name__ == '__main__':
    unittest.main()
