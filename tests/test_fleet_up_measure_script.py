import re
import subprocess
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/fleet-up-measure.sh'


class FleetScriptTests(unittest.TestCase):
    def test_syntax_is_valid(self):
        self.assertEqual(0, subprocess.run(['bash', '-n', str(SCRIPT)]).returncode)

    def test_the_fleet_is_always_removed_unless_explicitly_kept_and_up_succeeded(self):
        text = SCRIPT.read_text()
        self.assertIn('trap cleanup EXIT', text)
        self.assertIn('vast-pods.py down --yes', text)
        self.assertIn('"${KEEP:-0}" = "1" ] && [ "${UP_RC:-1}" = "0"', text)         # Behalten nur mit KEEP=1 UND erfolgreichem up

    def test_secrets_are_asked_invisibly_and_never_written_in_the_script(self):
        text = SCRIPT.read_text()
        self.assertIn('read -rsp', text)
        self.assertEqual([], re.findall(r'(ghp_|github_pat_|AKIA)[A-Za-z0-9_]{8,}', text))
        for name in ('VAST_API_KEY', 'GHCR_PASSWORD', 'R2_SECRET_ACCESS_KEY', 'HF_TOKEN'):
            self.assertIn('ask %s ' % name, text)

    def test_it_asks_for_confirmation_before_renting_and_uses_the_measured_settings(self):
        text = SCRIPT.read_text()
        self.assertLess(text.index('Zum Starten "ja"'), text.index('vast-pods.py up'))
        for setting in ('VAST_HEDGE_ROLES=all', 'VAST_LATE_HEDGE_SECONDS=360', 'VAST_HEDGE_CEILING_EUR_PER_HOUR=11'):
            self.assertIn(setting, text)


if __name__ == '__main__':
    unittest.main()
