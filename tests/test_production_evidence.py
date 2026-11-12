import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
spec = importlib.util.spec_from_file_location('evidence',ROOT/'scripts/production/collect-evidence.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class EvidenceTests(unittest.TestCase):
    def collect(self, ci=False, missing=None, rt_ok=True):
        reports = {}
        for role in ('app','sfu','media','edge'):
            reports['deploy-'+role] = {'stage':'services_started','commit':'expected','PRIVATE_TOKEN':'never-export'}
            reports['verify-'+role] = {'stage':'passed'}
        reports['rt-app'] = {'stage':'passed','commit':'expected','ciToleranceEnabled':ci,
                             'measurement':{'checks':[{'ok':rt_ok}]}}
        reports['ai-acceptance'] = {'stage':'passed','passed':True,'commit':'expected',
                                    'cleanupPassed':True,'independentCleanupPassed':True}
        if missing: reports.pop(missing)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            identity = root/'services/audiomonastry-ai-runtime'
            identity.mkdir(parents=True)
            for name in ('model_manifest.json','weight_assets.lock.json'):
                (identity/name).write_text('identity')
            output = root/'production-evidence'
            output.mkdir()
            (output/'dns.json').write_text('{"verificationPassed":true}')
            class Target:
                def get_bytes(self,key):
                    assert key.startswith('deployment/runs/123/1/')
                    data=reports.get(Path(key).stem)
                    return json.dumps(data).encode() if data is not None else None
            with patch.object(collector,'ROOT',root), patch.object(collector.S3Target,'from_r2_env',return_value=Target()), patch.dict(
                    os.environ,{'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':'expected'}):
                collector.main()
            summary = (output/'summary.json').read_text()
            self.assertNotIn('never-export',summary)
            return json.loads(summary)

    def test_complete_same_run_strict_evidence_passes(self):
        self.assertTrue(self.collect()['allProductionGatesPassed'])

    def test_ci_tolerance_failed_measurement_and_missing_reports_block_release(self):
        self.assertFalse(self.collect(ci=True)['allProductionGatesPassed'])
        self.assertFalse(self.collect(rt_ok=False)['allProductionGatesPassed'])
        result = self.collect(missing='verify-sfu')
        self.assertFalse(result['allProductionGatesPassed'])
        self.assertIn('verify-sfu',result['missingReports'])


if __name__ == '__main__':
    unittest.main()
