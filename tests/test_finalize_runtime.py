import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('finalize', ROOT / 'scripts/finalize-runtime-from-probe.py')
fin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fin)

STATE = {'instances': {'brain': {'id': 1, 'host': 'h1'}, 'vis': {'id': 3, 'host': 'h3'}, 'studio': {'id': 5, 'host': 'h5'}},
         'hedges': {'brain': {'id': 2, 'host': 'h2'}, 'vis': {'id': 4, 'host': 'h4'}}}


class WinnerTests(unittest.TestCase):
    def test_the_host_that_was_ready_first_wins_and_unmeasured_roles_are_missing(self):
        result = {'targets': {'brain': {'firstReadyS': 400.0}, 'brain-hedge': {'firstReadyS': 250.0},
                              'vis': {'firstReadyS': 30.0}, 'vis-hedge': {'firstReadyS': None}}}
        winners, missing = fin.choose_winners(STATE, result)
        self.assertEqual('hedge', winners['brain'][0])
        self.assertEqual('primary', winners['vis'][0])
        self.assertEqual(['studio'], missing)                       # studio ohne bereiten Host: Aufrufer entscheidet

    def test_a_role_without_any_ready_host_is_never_silently_dropped(self):
        winners, missing = fin.choose_winners(STATE, {'targets': {}})
        self.assertEqual({}, winners)
        self.assertEqual(['brain', 'studio', 'vis'], sorted(missing))

    def test_runtime_lines_name_the_winning_url_and_contain_no_vast_key(self):
        winners = {'audio-brain': ('primary', {'id': 9, 'host': 'h9', 'eurPerHour': 0.5})}
        lines = fin.runtime_lines(winners, {'9': 16412}, 'tok')
        text = '\n'.join(lines)
        self.assertIn('VAST_POD_URL_AUDIO_BRAIN=https://h9:16412', text)
        self.assertIn('AI_POD_TOKEN=tok', text)
        self.assertIn('NODE_EXTRA_CA_CERTS=/etc/audiomonastry-vast/ca.pem', text)
        self.assertNotIn('VAST_API_KEY', text)


if __name__ == '__main__':
    unittest.main()
