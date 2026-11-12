import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module
idle=load('production_idle','scripts/fleet-idle-teardown.py')
teardown=load('production_teardown','scripts/fleet-teardown.py')


class IdlePolicyTests(unittest.TestCase):
    def test_cleanup_inventory_rejects_unowned_or_misnamed_servers(self):
        owned={'id':1,'name':'audiomonastry-app-1','labels':{'app':'audiomonastry'}}
        foreign={'id':2,'name':'other-project','labels':{'app':'other'}}
        with patch.object(teardown,'hcloud',return_value=(200,{'servers':[owned,foreign]})) as api:
            self.assertEqual([owned],teardown.get_servers('test-key'))
        self.assertIn('label_selector=app%3Daudiomonastry',api.call_args.args[2])

    def test_public_authenticated_signal_uses_fifteen_minute_boundary(self):
        with patch.object(idle,'http_json',return_value=(200,{'verdict':'idle'})) as call:
            self.assertEqual('idle',idle.idle_signal('1.1.1.1','test-auth')[0])
        self.assertEqual('https://hallerbans.de/api/idle-signal?thresholdSec=900',call.call_args.args[0])
        self.assertEqual({'x-studio-token':'test-auth'},call.call_args.args[1])

    def test_missing_app_does_not_leave_other_billed_roles_behind(self):
        with patch.object(sys,'argv',['idle','--apply']), patch.object(idle,'load_env',return_value={'HCLOUD_TOKEN':'test-key'}), patch.object(
                idle,'deploy_running',return_value=False), patch.object(idle,'app_ip',return_value=''), patch.object(
                idle,'run_teardown',return_value=0) as cleanup:
            self.assertEqual(0,idle.main())
        cleanup.assert_called_once()

    def test_unreadable_inventory_is_not_equivalent_to_missing_app(self):
        with patch.object(idle,'http_json',return_value=(401,{})):
            with self.assertRaisesRegex(RuntimeError,'INVENTORY_UNREADABLE'):idle.app_ip('test-key')

    def test_unknown_gpu_inventory_cannot_claim_zero_cost(self):
        with patch.object(sys,'argv',['teardown','--yes']), patch.object(teardown,'load_env',return_value={'HCLOUD_TOKEN':'test-key'}), patch.object(
                teardown,'get_servers',return_value=[]), patch.object(teardown,'pods_down',return_value=False), patch.object(
                teardown,'pods_running_count',return_value=-1), patch.dict('os.environ',{},clear=False):
            self.assertEqual(4,teardown.main())

    def test_watchdog_host_is_deleted_after_other_roles_and_verified_snapshots(self):
        servers=[{'id':i,'name':'audiomonastry-'+role+'-1','labels':{'role':role},
            'server_type':{'disk':40,'name':'test'},'status':'running'} for i,role in enumerate(('app','sfu','media','edge'),1)]
        with patch.object(sys,'argv',['teardown','--yes']), patch.object(teardown,'load_env',return_value={
                'HCLOUD_TOKEN':'test-key','FLEET_TEARDOWN_RUNNER_ROLE':'edge'}), patch.object(teardown,'get_servers',side_effect=[servers,[]]), patch.object(
                teardown,'pods_down',return_value=True), patch.object(teardown,'pods_running_count',return_value=0), patch.object(
                teardown,'create_snapshot',return_value=123), patch.object(teardown,'wait_snapshot',return_value=True), patch.object(
                teardown,'delete_server',return_value=True) as delete, patch.dict('os.environ',{},clear=False):
            self.assertEqual(0,teardown.main())
        self.assertEqual('audiomonastry-edge-1',delete.call_args_list[-1].args[2])
        self.assertEqual(4,delete.call_count)


if __name__=='__main__':unittest.main()
