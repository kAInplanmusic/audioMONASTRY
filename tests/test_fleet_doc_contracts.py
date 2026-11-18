"""Fleet pipeline contract tests: every assertion cites the vendor documentation it comes from (docs/FLEET_EVIDENCE.md, docs/evidence/SOURCES.json).

Hermetic: the documentation facts are written down here with their source URL; nothing is fetched. When a vendor page changes, refresh
docs/evidence/SOURCES.json and update the constants below together with the code.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import unittest
import urllib.error
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vast = load('vast_contracts', 'scripts/vast-pods.py')
sys.path.insert(0, str(ROOT / 'scripts'))
import s3lite  # noqa: E402  (Dataclass braucht ein registriertes Modul)
planner = vast.planner

# --- Vast: https://docs.vast.ai/api-reference/instances/create-instance.md -------------------------------------------------------
VAST_CREATE_FIELDS = {'image', 'template_hash_id', 'label', 'disk', 'runtype', 'target_state', 'price', 'env', 'cancel_unavail', 'vm',
                      'onstart', 'args', 'args_str', 'use_jupyter_lab', 'jupyter_dir', 'python_utf8', 'lang_utf8', 'force', 'user',
                      'image_login', 'volume_info'}
VAST_RUNTYPES = {'ssh', 'jupyter', 'args', 'ssh_proxy', 'ssh_direct', 'jupyter_proxy', 'jupyter_direct'}
VAST_TARGET_STATES = {'running', 'stopped'}
VAST_ONSTART_MAX_CHARS = 4048                       # "onstart field is limited to 4048 characters" (create-instance quirks)
VAST_MAX_OPEN_PORTS = 64                            # https://docs.vast.ai/guides/instances/connect/networking.md
VAST_NEVER_RUNNING = {'exited', 'unknown', 'offline'}   # "Poll trap" (create-instance quirks)
# --- Vast: https://docs.vast.ai/api-reference/search/search-offers.md (request schema) ----------------------------------------------
VAST_SEARCH_FIELDS = {
    'allocated_storage', 'bw_nvlink', 'compute_cap', 'cpu_arch', 'cpu_cores', 'cpu_cores_effective', 'cpu_ghz', 'cpu_ram', 'cuda_max_good',
    'datacenter', 'direct_port_count', 'disk_bw', 'disk_space', 'dlperf', 'dlperf_per_dphtotal', 'dph_total', 'driver_version', 'duration',
    'external', 'flops_per_dphtotal', 'geolocation', 'gpu_arch', 'gpu_display_active', 'gpu_frac', 'gpu_max_power', 'gpu_max_temp',
    'gpu_mem_bw', 'gpu_name', 'gpu_ram', 'gpu_total_ram', 'has_avx', 'host_id', 'id', 'inet_down', 'inet_down_cost', 'inet_up',
    'inet_up_cost', 'limit', 'machine_id', 'min_bid', 'mobo_name', 'num_gpus', 'offers', 'order', 'os_version', 'pci_gen', 'pcie_bw',
    'properties', 'reliability', 'rentable', 'rented', 'static_ip', 'storage_cost', 'total_flops', 'type', 'ubuntu_version',
    'verification', 'verified', 'vms_enabled'}
VAST_OFFER_TYPES = {'ondemand', 'bid', 'reserved'}
# --- Cloudflare: https://developers.cloudflare.com/r2/api/s3/presigned-urls/ -------------------------------------------------------
R2_PRESIGN_MIN_S, R2_PRESIGN_MAX_S = 1, 604_800
R2_PRESIGN_METHODS = {'GET', 'PUT', 'HEAD', 'DELETE'}
ALLOWED_SOURCE_HOSTS = {'docs.vast.ai', 'docs.github.com', 'developers.cloudflare.com'}

POD = {'role': 'brain', 'containerDiskGb': 120, 'minRamPerGpu': 32, 'minVcpuCountPerGpu': 8, 'minCudaVersion': '12.4', 'models': []}


class VastCreateBodyContract(unittest.TestCase):
    def body(self, **overrides):
        args = dict(image='ghcr.io/o/i@sha256:' + 'a' * 64, disk_gb=120, label='audiomonastry-vast-brain-1', env={'AI_ROLE': 'brain'},
                    username='octo', password='ghp_' + 'x' * 36)
        args.update(overrides)
        return vast.create_body(**args)

    def test_only_documented_fields_with_documented_values(self):
        body = self.body()
        self.assertLessEqual(set(body), VAST_CREATE_FIELDS)
        self.assertIn(body['runtype'], VAST_RUNTYPES)
        self.assertIn(body['target_state'], VAST_TARGET_STATES)
        self.assertIsInstance(body['disk'], (int, float))
        self.assertGreater(body['disk'], 0)
        self.assertIs(body['cancel_unavail'], True)                       # on-demand: do not wait for hardware (create-instance)
        if 'onstart' in body:
            self.assertLessEqual(len(body['onstart']), VAST_ONSTART_MAX_CHARS)

    def test_args_runtype_keeps_the_image_entrypoint_and_needs_no_onstart(self):
        # creating-instances-with-api: "args: Container runs with the original entrypoint ... No SSH/Jupyter"; onstart belongs to ssh/jupyter.
        body = self.body()
        self.assertEqual('args', body['runtype'])
        self.assertNotIn('onstart', body)

    def test_env_is_an_object_with_dash_p_port_keys_valued_one(self):
        # creating-instances-with-api: "env: JSON object ... port mappings use the Docker -p syntax as keys with "1" as the value"
        env = self.body()['env']
        self.assertIsInstance(env, dict)
        ports = {k: v for k, v in env.items() if k.startswith('-p ')}
        self.assertEqual({'-p 8000:8000': '1'}, ports)
        self.assertLessEqual(len(ports), VAST_MAX_OPEN_PORTS)
        for key in ports:
            self.assertRegex(key, r'^-p \d{1,5}:\d{1,5}(/(tcp|udp))?$')

    def test_image_login_uses_the_documented_format(self):
        # image_login example: "-u username -p access_token docker.io"
        login = self.body()['image_login']
        self.assertRegex(login, r'^-u \S+ -p \S+ ghcr\.io$')
        self.assertNotIn(' ', login.split(' -p ', 1)[1].rsplit(' ', 1)[0])

    def test_shell_metacharacters_in_credentials_stay_inside_one_argument(self):
        login = self.body(password="pa ss'word;rm")['image_login']
        self.assertTrue(login.endswith(' ghcr.io'))
        self.assertIn("'", login)                                        # shlex.quote kept it a single token


class GhcrAuthContract(unittest.TestCase):
    # https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry
    def test_only_classic_personal_access_tokens_are_accepted(self):
        self.assertIsNone(vast.ghcr_token_problem('ghp_' + 'a' * 36))
        self.assertIn('classic', vast.ghcr_token_problem('github_pat_' + 'a' * 60))


class VastSearchContract(unittest.TestCase):
    def test_every_query_key_is_a_documented_filter(self):
        with patch.object(planner, 'memory_required', return_value=24), patch.object(planner, 'minimum_reliability', return_value=0.97):
            query = planner.query({**POD, 'minDownloadMbps': 800}, {}, 'europe')
        self.assertLessEqual(set(query), VAST_SEARCH_FIELDS)
        self.assertIn(query['type'], VAST_OFFER_TYPES)

    def test_gpu_ram_is_sent_in_megabytes(self):
        # create-instance quirks: "gpu_ram in CLI = GB; in REST API = MB"
        with patch.object(planner, 'memory_required', return_value=24), patch.object(planner, 'minimum_reliability', return_value=0.97):
            self.assertEqual(24 * 1024, planner.query(POD, {})['gpu_ram']['gte'])

    def test_offer_limit_is_bounded_to_protect_the_search_quota(self):
        with patch.object(planner, 'memory_required', return_value=24), patch.object(planner, 'minimum_reliability', return_value=0.97):
            with patch.dict(os.environ, {'VAST_PLAN_OFFER_LIMIT': '999999'}):
                self.assertEqual(1000, planner.query(POD, {})['limit'])
            with patch.dict(os.environ, {'VAST_PLAN_OFFER_LIMIT': '40'}):
                self.assertEqual(40, planner.query(POD, {})['limit'])
            env = {k: v for k, v in os.environ.items() if k != 'VAST_PLAN_OFFER_LIMIT'}
            with patch.dict(os.environ, env, clear=True):
                self.assertEqual(100, planner.query(POD, {})['limit'])      # Betreiber 2026-11-18: Standard 100 statt 40


class VastLifecycleContract(unittest.TestCase):
    def test_statuses_that_never_reach_running_are_terminal(self):
        for status in VAST_NEVER_RUNNING:
            with self.assertRaisesRegex(RuntimeError, 'Terminal instance status'):
                vast.fail_on_terminal_instance({'actual_status': status}, 'vis')
        for status in ('loading', 'running', 'created', 'scheduling', None):       # loading = image download (manage-instances)
            vast.fail_on_terminal_instance({'actual_status': status}, 'vis')

    def test_a_rate_limited_create_never_buys_twice(self):
        # rate-limits-and-errors: HTTP 429, no Retry-After header -> client backoff. A second PUT could rent a second GPU.
        calls = []

        def refuse(request, timeout=0):
            calls.append((request.get_method(), request.full_url))
            raise urllib.error.HTTPError(request.full_url, 429, 'API requests too frequent', {}, None)

        with patch.dict(os.environ, {'VAST_API_KEY': 'k'}), patch.object(vast.urllib.request, 'urlopen', side_effect=refuse), \
                patch.object(vast.time, 'sleep'), patch.object(vast, 'instances', return_value=[]):
            with self.assertRaisesRegex(RuntimeError, 'no paid retry'):
                vast.api('PUT', '/api/v0/asks/123/', {'label': 'x', 'image': 'i'})
        self.assertEqual(1, sum(1 for method, url in calls if method == 'PUT' and '/asks/' in url))

    def test_the_new_instance_id_comes_from_new_contract(self):
        # create-instance quirks: "returns new_contract as the instance ID, not id"
        source = (ROOT / 'scripts/vast-pods.py').read_text()
        self.assertIn("result.get('new_contract')", source)


class R2PresignContract(unittest.TestCase):
    def target(self):
        return s3lite.S3Target('https://acc.r2.cloudflarestorage.com', 'bucket', 'AK', 'SK', 'auto')

    def test_expiry_is_limited_to_the_documented_range(self):
        t = self.target()
        for ok in (R2_PRESIGN_MIN_S, 3600, R2_PRESIGN_MAX_S):
            self.assertIn('X-Amz-Expires=%d' % ok, t.presign('GET', 'k', expires=ok))
        for bad in (0, -5, R2_PRESIGN_MAX_S + 1):
            with self.assertRaises(ValueError):
                t.presign('GET', 'k', expires=bad)

    def test_methods_are_limited_and_signed_per_method(self):
        t = self.target()
        now = __import__('datetime').datetime(2026, 11, 18, tzinfo=__import__('datetime').timezone.utc)
        urls = {m: t.presign(m, 'k', expires=60, now=now) for m in R2_PRESIGN_METHODS}
        self.assertEqual(len({u.split('X-Amz-Signature=')[1] for u in urls.values()}), 4)   # GET-URL taugt nicht fuer HEAD
        with self.assertRaises(ValueError):
            t.presign('POST', 'k')

    def test_weight_url_ttl_in_the_fleet_config_is_within_range(self):
        ttl = json.loads((ROOT / 'deploy/gpu/pod-fleet.json').read_text())['weights']['urlTtlSeconds']
        self.assertGreaterEqual(ttl, 3600)                                # laenger als ein Kaltstart
        self.assertLessEqual(ttl, R2_PRESIGN_MAX_S)

    def test_pods_probe_and_download_with_range_get_not_head(self):
        # presigned GET URLs cannot be used for HEAD (signature covers the method); Range GET is supported (r2/api/s3/api: GetObject)
        text = (ROOT / 'services/audiomonastry-ai-runtime/pod_start.py').read_text()
        self.assertIn('"Range"', text)
        self.assertNotIn("method='HEAD'", text)
        self.assertNotIn('method="HEAD"', text)


class EvidenceManifest(unittest.TestCase):
    def test_every_source_has_a_vendor_url_time_and_checksum(self):
        data = json.loads((ROOT / 'docs/evidence/SOURCES.json').read_text())
        self.assertGreater(len(data['sources']), 20)
        for row in data['sources']:
            self.assertRegex(row['url'], r'^https://(%s)/' % '|'.join(re.escape(h) for h in ALLOWED_SOURCE_HOSTS), row['url'])
            self.assertRegex(row['sha256'], r'^[0-9a-f]{64}$')
            self.assertGreater(row['bytes'], 500)
            self.assertRegex(row['fetchedAt'], r'^\d{4}-\d\d-\d\dT\d\d:\d\dZ$')
        vendors = {r['vendor'] for r in data['sources']}
        self.assertEqual({'vast', 'github', 'cloudflare'}, vendors)


if __name__ == '__main__':
    unittest.main()
