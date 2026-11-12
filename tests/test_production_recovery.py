import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('production_recovery',
    Path(__file__).resolve().parents[1] / 'scripts/production/provision.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.images = [{'id': n, 'status': 'available', 'created': '2026-11-12',
                        'disk_size': disk, 'description': 'audiomonastry-snapshot-audiomonastry-' + role + '-1-20261112'}
                       for n, (role, disk) in enumerate(zip(recovery.NAMES, (320, 160, 160, 40)), 1)]
        self.firewalls = [{'id': n, 'name': 'audiomonastry-prod-' + role + '-20261112',
                           'labels': {'managed-by': 'production-deploy'}}
                          for n, role in enumerate(recovery.NAMES, 1)]
        self.types = [{'id': n, 'name': name, 'disk': disk, 'architecture': 'x86',
                       'locations': [{'name': 'fsn1', 'available': True}]}
                      for n, (name, disk) in enumerate(zip(recovery.TYPES, (40, 80, 160, 320)), 1)]

    def test_newest_recovery_preserves_disk_capacity(self):
        older = dict(self.images[0], id=10, created='2026-10-01', disk_size=40)
        plan = recovery.recovery_plan([], [older] + self.images, self.firewalls, self.types)
        self.assertEqual({'app': 'cx53', 'sfu': 'cx43', 'media': 'cx43', 'edge': 'cx23'},
                         {role: item['type'] for role, item in plan.items()})
        self.assertEqual(1, plan['app']['image'])

    def test_partial_recovery_keeps_existing_server(self):
        server = {'name': recovery.NAMES['app'], 'labels': {'app': 'audioMONASTRY', 'role': 'app'}}
        plan = recovery.recovery_plan([server], self.images[1:], self.firewalls, self.types)
        self.assertIs(server, plan['app']['existing'])
        with self.assertRaisesRegex(RuntimeError, 'OWNERSHIP_MISMATCH'):
            recovery.recovery_plan([dict(server, labels={})], self.images, self.firewalls, self.types)

    def test_missing_role_blocks_before_any_allocation(self):
        api = Mock()
        with patch.object(recovery, 'collection', side_effect=[[], self.images[:3], self.firewalls, self.types]):
            with self.assertRaisesRegex(RuntimeError, 'SNAPSHOT_MISSING:edge'):
                recovery.restore(api, 'ssh-ed25519 public')
        api.assert_not_called()

    def test_fully_running_fleet_is_idempotent(self):
        servers = [{'name': name, 'id': n, 'status': 'running',
                    'labels': {'app': 'audiomonastry', 'role': role}}
                   for n, (role, name) in enumerate(recovery.NAMES.items(), 1)]
        api = Mock()
        key = {'id': 1, 'public_key': 'ssh-ed25519 public prior-comment'}
        with patch.object(recovery, 'collection', side_effect=[servers, [], [], [], [key], servers]):
            restored = recovery.restore(api, 'ssh-ed25519 public')
        self.assertEqual(4, len(restored))
        api.assert_not_called()

    def test_available_european_location_is_selected_before_create(self):
        types = [dict(t, locations=[{'name': 'nbg1', 'available': True}]) for t in self.types]
        plan = recovery.recovery_plan([], self.images, self.firewalls, types)
        self.assertTrue(all(item['location'] == 'nbg1' for item in plan.values()))
        with self.assertRaisesRegex(RuntimeError, 'NO_RECOVERY_CAPACITY'):
            recovery.recovery_plan([], self.images, self.firewalls,
                                   [dict(t, locations=[]) for t in self.types])

    def test_pagination_keeps_later_role_snapshots(self):
        api = Mock(side_effect=[{'images': [1], 'meta': {'pagination': {'next_page': 2}}},
                                {'images': [2], 'meta': {'pagination': {'next_page': None}}}])
        self.assertEqual([1, 2], recovery.collection(api, 'images', 'type=snapshot'))
        self.assertIn('page=2', api.call_args.args[1])


if __name__ == '__main__':
    unittest.main()
