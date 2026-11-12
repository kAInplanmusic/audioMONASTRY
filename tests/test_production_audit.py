import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts/production'))
spec=importlib.util.spec_from_file_location('audit_cleanup_test',ROOT/'scripts/production/audit-snapshot.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)

class AuditCleanupTests(unittest.TestCase):
    def test_diagnostics_ownership_requires_the_exact_run_and_managed_label(self):
        labels={'app':'audiomonastry-diagnostics','managed-by':'production-audit','audit-run':'123'}
        self.assertTrue(audit.owned({'labels':labels},'123'))
        self.assertFalse(audit.owned({'labels':labels},'124'))
        self.assertFalse(audit.owned({'labels':{**labels,'app':'audiomonastry'}},'123'))

    def test_cleanup_removes_only_the_isolated_copy_and_its_generated_snapshot(self):
        labels={'app':'audiomonastry-diagnostics','managed-by':'production-audit','audit-run':'123'}
        server={'id':42,'name':'am-audit-app-123','labels':labels};firewall={'id':43,'labels':labels}
        deleted=[]
        def api(method,path,body=None):
            if method=='DELETE':deleted.append(path);return {}
            if method=='POST':self.assertEqual({'delete':False,'rebuild':False},body);return {}
            if path.startswith('servers?'):return {'servers':[] if 'servers/42' in deleted else [server,{'id':7,'labels':{'app':'audiomonastry'}}]}
            if path.startswith('firewalls?'):return {'firewalls':[] if 'firewalls/43' in deleted else [firewall,{'id':8,'labels':{'app':'audiomonastry'}}]}
            raise AssertionError(path)
        images=[{'id':44,'created_from':{'name':'am-audit-app-123'}},{'id':45,'created_from':{'name':'audiomonastry-app-1'}}]
        with patch.object(audit.deploy,'api',side_effect=api),patch.object(audit.provision,'collection',return_value=images):
            self.assertTrue(audit.cleanup('123'))
        self.assertEqual(['servers/42','images/44','firewalls/43'],deleted)

    def test_canonical_server_name_cannot_be_deleted_as_an_audit_copy(self):
        server={'id':42,'name':'audiomonastry-app-1','labels':{'app':'audiomonastry-diagnostics','managed-by':'production-audit','audit-run':'123'}}
        with patch.object(audit.deploy,'api',return_value={'servers':[server]}):
            with self.assertRaisesRegex(RuntimeError,'OWNERSHIP_MISMATCH'):audit.cleanup('123')

if __name__=='__main__':unittest.main()
