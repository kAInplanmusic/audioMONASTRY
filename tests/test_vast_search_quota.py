import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

spec=importlib.util.spec_from_file_location('vast_quota_planner',Path(__file__).resolve().parents[1]/'scripts/vast-fleet-plan.py')
planner=importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)

class SearchQuotaTest(unittest.TestCase):
    def setUp(self):planner._SEARCH_BLOCKED=None
    def tearDown(self):planner._SEARCH_BLOCKED=None
    def test_daily_quota_stops_pending_and_subsequent_process_searches(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'quota.json'
            error=urllib.error.HTTPError(planner.URL,429,'rate limit',{'Retry-After':'7200'},io.BytesIO(b'Daily search row quota exhausted'))
            with patch.dict('os.environ',{'VAST_SEARCH_QUOTA_STATE':str(path)}),patch.object(planner.urllib.request,'urlopen',side_effect=error) as request:
                with self.assertRaises(planner.SearchQuotaBlocked):planner.search({'limit':5})
                self.assertEqual(json.loads(path.read_text())['retryAfterSeconds'],7200)
                with self.assertRaises(planner.SearchQuotaBlocked):planner.search({'limit':5})
                planner._SEARCH_BLOCKED=None
                with self.assertRaises(planner.SearchQuotaBlocked):planner.search({'limit':5})
                self.assertEqual(request.call_count,1)
    def test_rate_limit_does_not_export_provider_body(self):
        error=urllib.error.HTTPError(planner.URL,429,'rate limit',{'Retry-After':'60'},io.BytesIO(b'private provider details'))
        with patch.object(planner.urllib.request,'urlopen',side_effect=error):
            with self.assertRaises(planner.SearchQuotaBlocked) as raised:planner.search({'limit':5})
        self.assertNotIn('private provider details',str(raised.exception))
        self.assertEqual(json.loads(str(raised.exception))['retryAfterSeconds'],60)

if __name__=='__main__':unittest.main()
