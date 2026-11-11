"""R2 regression: a partial file mirror must not hide a complete TAR."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("pods_r2_regression", ROOT / "scripts/runpod-pods.py")
pods = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pods)
REV = "a" * 40
SHA = "b" * 64


class Target:
    def __init__(self, files, tar=True, revision=REV, repo="owner/model"):
        self.doc = {"revision": revision, "repo": repo, "files": files}
        self.tar = tar

    def get_bytes(self, key):
        if key.endswith("_manifest.json"):
            return json.dumps(self.doc).encode()
        return (SHA + "  model.tar").encode() if self.tar else None

    def head(self, key):
        return {"content-length": "100"} if self.tar and key.endswith(".tar") else None

    def presign(self, method, key, ttl):
        return "https://example.test/" + key


class ManifestCompletenessTests(unittest.TestCase):
    def models(self):
        return {"fixture": {"repository": "owner/model", "revision": REV,
                            "requiredWeightFiles": [{"path": "model.safetensors", "size": 4096}]}}

    def entries(self, target):
        return pods.weight_entries({"models": ["fixture"]}, self.models(), target, "weights", 3600)

    def test_incomplete_file_mirror_falls_back_to_tar(self):
        entries, missing = self.entries(Target([{"path": "config.json", "size": 2, "sha256": SHA}]))
        self.assertEqual(missing, [])
        self.assertTrue(entries[0]["name"].endswith(".tar"))
        self.assertEqual(entries[0]["sha256"], SHA)

    def test_incomplete_mirror_without_tar_is_missing(self):
        entries, missing = self.entries(Target([{"path": "config.json", "size": 2, "sha256": SHA}], tar=False))
        self.assertEqual(entries, [])
        self.assertEqual(len(missing), 1)

    def test_complete_file_mirror_remains_preferred(self):
        entries, missing = self.entries(Target([{"path": "model.safetensors", "size": 4096, "sha256": SHA}]))
        self.assertEqual(missing, [])
        self.assertEqual(entries[0]["path"], "model.safetensors")

    def test_wrong_weight_size_is_incomplete(self):
        entries, _ = self.entries(Target([{"path": "model.safetensors", "size": 10, "sha256": SHA}]))
        self.assertIn("name", entries[0])

    def test_wrong_revision_is_rejected(self):
        entries, _ = self.entries(Target([{"path": "model.safetensors", "size": 4096, "sha256": SHA}], revision="c" * 40))
        self.assertIn("name", entries[0])

    def test_wrong_repository_is_rejected(self):
        entries, _ = self.entries(Target([{"path": "model.safetensors", "size": 4096, "sha256": SHA}], repo="wrong/model"))
        self.assertIn("name", entries[0])

    def test_auxiliary_checkpoint_uses_signed_url_and_pinned_hash(self):
        lock = json.loads((ROOT / "services/audiomonastry-ai-runtime/weight_assets.lock.json").read_text())["models"]
        checkpoint = lock["beat-this"]["files"][0]
        class AuxiliaryTarget(Target):
            def head(self, key):
                return {"content-length": str(checkpoint["size"])} if key.endswith("final0.ckpt") else None
        model = {"beat-this": {"repository": lock["beat-this"]["repository"],
                               "revision": lock["beat-this"]["revision"], "directRepo": True}}
        entries, missing = pods.weight_entries({"models": ["beat-this"]}, model,
                                               AuxiliaryTarget([], tar=False), "weights", 3600)
        self.assertEqual(missing, [])
        self.assertEqual(entries[0]["dest"], "/data/weights/beat-this/final0.ckpt")
        self.assertEqual(entries[0]["sha256"], checkpoint["sha256"])
        self.assertIn("final0.ckpt", entries[0]["url"])


class RoleImageTests(unittest.TestCase):
    def test_song_uses_validated_profile_instead_of_common_image(self):
        from unittest.mock import patch
        fleet = json.loads((ROOT / 'deploy/runpod/pod-fleet.json').read_text())
        song = next(p for p in fleet['pods'] if p['role'] == 'song')
        with patch.dict('os.environ', {'RP_POD_IMAGE': 'incompatible-common'}, clear=True):
            self.assertEqual(pods.resolve_image(fleet, song), song['image'])
        body = pods.pod_body(fleet, song, song['image'], 'x' * 32, [])
        self.assertEqual(body['gpu']['minCudaVersion'], '12.8')

    def test_explicit_song_image_override_wins(self):
        from unittest.mock import patch
        with patch.dict('os.environ', {'RP_SONG_IMAGE': 'operator-image'}, clear=True):
            self.assertEqual(pods.resolve_image({'imageEnv': 'RP_POD_IMAGE'},
                             {'imageEnv': 'RP_SONG_IMAGE', 'image': 'pinned-default'}), 'operator-image')

    def test_required_brain_profile_cannot_inherit_common_image(self):
        from unittest.mock import patch
        with patch.dict('os.environ', {'RP_POD_IMAGE': 'common'}, clear=True):
            with self.assertRaises(pods.ConfigError):
                pods.resolve_image({'imageEnv': 'RP_POD_IMAGE'}, {'imageEnv': 'RP_BRAIN_IMAGE'})



class LiveGpuSelectionTests(unittest.TestCase):
    def setUp(self):
        self.fleet=pods.load_fleet()
        self.models=pods.load_models()
        self.pod=next(p for p in self.fleet['pods'] if p['role']=='audio-brain')

    def gpu(self,name,memory,cuda='13.2',availability='LOW'):
        return {'id':name,'memory':memory,'availability':availability,
                'price':{'community':.6},'cudaVersions':[{'available':True,'version':cuda}]}

    def test_unavailable_first_choice_uses_approved_next_gpu(self):
        selected,rate=pods.choose_live_gpu(self.fleet,self.pod,self.models,{'gpus':[
            self.gpu('NVIDIA GeForce RTX 5090',32,availability='NONE'),
            self.gpu('NVIDIA GeForce RTX 4090',24)]})
        self.assertEqual(selected['gpuPoolId'],'NVIDIA GeForce RTX 4090')
        self.assertEqual(rate,.6)

    def test_incompatible_cuda_is_rejected(self):
        with self.assertRaises(pods.ConfigError):
            pods.choose_live_gpu(self.fleet,self.pod,self.models,{'gpus':[self.gpu('NVIDIA GeForce RTX 5090',32,cuda='12.6')]})

    def test_insufficient_live_memory_is_rejected(self):
        with self.assertRaises(pods.ConfigError):
            pods.choose_live_gpu(self.fleet,self.pod,self.models,{'gpus':[self.gpu('NVIDIA GeForce RTX 5090',16)]})



class StartupRollbackTests(unittest.TestCase):
    def test_failed_final_cost_probe_removes_new_pod_and_preserves_existing_pod(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        fleet = pods.load_fleet()
        brain = next(p for p in fleet['pods'] if p['role'] == 'brain')
        calls = []
        def api(method, path, body=None):
            calls.append((method, path))
            if method == 'GET': return 200, {'gpus': []}
            if method == 'POST': return 201, {'id': 'new-brain', 'cost': .74}
            return 204, None
        existing = [{'name': fleet['namePrefix']+'ears', 'id': 'existing-ears', 'desiredStatus': 'RUNNING'}]
        with patch.dict('os.environ', {'AI_POD_TOKEN': 'x'*40, 'RP_API_KEY': 'fixture', 'RP_BRAIN_IMAGE': 'fixture'}), \
             patch.object(pods.s3lite.S3Target, 'from_r2_env', return_value=object()), \
             patch.object(pods, 'fleet_pods', return_value=existing), \
             patch.object(pods, 'weight_entries', return_value=([], [])), \
             patch.object(pods, 'choose_live_gpu', return_value=(brain, .74)), \
             patch.object(pods, 'live_fleet_cost', side_effect=[{'existingComputeUsdPerHour': 0}, RuntimeError('probe unavailable')]), \
             patch.object(pods, 'api', side_effect=api):
            with self.assertRaisesRegex(RuntimeError, 'probe unavailable'):
                pods.cmd_up(SimpleNamespace(only='brain', yes=True, wait=0), fleet, pods.load_models())
        self.assertEqual([path for method,path in calls if method=='DELETE'], ['/pods/new-brain'])



class CloudSelectionTests(unittest.TestCase):
    def test_secure_availability_uses_secure_price_and_create_cloud(self):
        fleet=pods.load_fleet();models=pods.load_models()
        pod=next(p for p in fleet['pods'] if p['role']=='audio-brain')
        base={'id':'NVIDIA GeForce RTX 5090','memory':32,
              'price':{'community':.69,'secure':1.19},
              'cudaVersions':[{'available':True,'version':'13.2'}]}
        selected,rate=pods.choose_live_gpu(fleet,pod,models,{'gpus':[
            {**base,'_cloud':'COMMUNITY','availability':'NONE'},
            {**base,'_cloud':'SECURE','availability':'LOW'}]})
        self.assertEqual(rate,1.19)
        self.assertEqual(pods.pod_body(fleet,selected,'fixture','x'*40,[])['cloud'],'SECURE')



class CapacityRetryTests(unittest.TestCase):
    def test_explicit_capacity_rejection_tries_next_gpu(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        fleet=pods.load_fleet();attempts=[]
        catalog={'gpus':[{'id':name,'memory':48,'availability':'LOW',
            'price':{'secure':rate},'cudaVersions':[{'available':True,'version':'13.2'}]}
            for name,rate in [('NVIDIA RTX 6000 Ada Generation',.99),('NVIDIA L40S',1.09)]]}
        def api(method,path,body=None):
            if method=='GET':return 200,catalog if 'cloud=SECURE' in path else {'gpus':[]}
            if method=='POST':
                attempts.append(body['gpu']['id'])
                if len(attempts)==1:return 400,{'detail':'There are no longer any instances available with the requested specifications.'}
                return 201,{'id':'allocated','cost':1.09}
            return 204,None
        with patch.dict('os.environ',{'AI_POD_TOKEN':'x'*40,'RP_API_KEY':'fixture','RP_BRAIN_IMAGE':'fixture'}), \
             patch.object(pods.s3lite.S3Target,'from_r2_env',return_value=object()), \
             patch.object(pods,'fleet_pods',return_value=[]), \
             patch.object(pods,'weight_entries',return_value=([],[])), \
             patch.object(pods,'live_fleet_cost',return_value={'existingComputeUsdPerHour':0}), \
             patch.object(pods,'api',side_effect=api):
            self.assertEqual(pods.cmd_up(SimpleNamespace(only='brain',yes=True,wait=0),fleet,pods.load_models()),0)
        self.assertEqual(attempts,['NVIDIA RTX 6000 Ada Generation','NVIDIA L40S'])


    def test_capacity_rejection_tries_next_data_center(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        fleet=pods.load_fleet();attempts=[]
        catalog={'gpus':[{'id':'NVIDIA L40S','memory':48,'availability':'LOW',
            'price':{'secure':1.09},'cudaVersions':[{'available':True,'version':'13.2'}],
            'dataCenters':[{'id':'EU-1','availability':'LOW'},{'id':'US-1','availability':'LOW'}]}]}
        def api(method,path,body=None):
            if method=='GET':return 200,catalog if 'cloud=SECURE' in path else {'gpus':[]}
            if method=='POST':
                attempts.append(body.get('dataCenterIds'))
                if len(attempts)==1:return 400,{'detail':'There are no longer any instances available with the requested specifications.'}
                return 201,{'id':'allocated','cost':1.09}
            return 204,None
        with patch.dict('os.environ',{'AI_POD_TOKEN':'x'*40,'RP_API_KEY':'fixture','RP_BRAIN_IMAGE':'fixture'}), \
             patch.object(pods.s3lite.S3Target,'from_r2_env',return_value=object()), \
             patch.object(pods,'fleet_pods',return_value=[]), \
             patch.object(pods,'weight_entries',return_value=([],[])), \
             patch.object(pods,'live_fleet_cost',return_value={'existingComputeUsdPerHour':0}), \
             patch.object(pods,'api',side_effect=api):
            self.assertEqual(pods.cmd_up(SimpleNamespace(only='brain',yes=True,wait=0),fleet,pods.load_models()),0)
        self.assertEqual(attempts,[['EU-1'],['US-1']])



class WholeFleetReservationTests(unittest.TestCase):
    def test_future_studio_cost_blocks_before_any_pod_is_created(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        fleet=pods.load_fleet();posts=[]
        rows=[{'id':n,'memory':v,'availability':'LOW','price':{'secure':rate},
               'cudaVersions':[{'available':True,'version':'13.2'}]}
              for n,v,rate in [('NVIDIA L40S',48,1.09),('NVIDIA RTX PRO 6000 Blackwell Server Edition',96,8)]]
        def api(method,path,body=None):
            if method=='POST':posts.append(body)
            return 200,{'gpus':rows if 'cloud=SECURE' in path else []}
        with patch.dict('os.environ',{'AI_POD_TOKEN':'x'*40,'RP_API_KEY':'fixture','RP_BRAIN_IMAGE':'fixture'}), \
             patch.object(pods.s3lite.S3Target,'from_r2_env',return_value=object()), \
             patch.object(pods,'fleet_pods',return_value=[]), \
             patch.object(pods,'weight_entries',return_value=([],[])), \
             patch.object(pods,'live_fleet_cost',return_value={'existingComputeUsdPerHour':0}), \
             patch.object(pods,'api',side_effect=api):
            self.assertEqual(pods.cmd_up(SimpleNamespace(only='brain,studio',yes=True,wait=0),fleet,pods.load_models()),4)
        self.assertEqual(posts,[])


if __name__ == "__main__":
    unittest.main()
