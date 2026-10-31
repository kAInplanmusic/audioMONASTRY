"""Offline checks for Docker build context and public Vite build configuration.

These tests do not inspect any real .env file. A daemon-backed image test is
still needed in an environment with Docker available.
"""
import fnmatch
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


def excluded(path: str) -> bool:
    # The rules tested below use Docker's root or **/ patterns, with last rule
    # winning. This deliberately does not pretend to implement all of moby/patternmatcher.
    result = False
    for raw in (ROOT / '.dockerignore').read_text().splitlines():
        rule = raw.strip()
        if not rule or rule.startswith('#'):
            continue
        negate = rule.startswith('!')
        if negate:
            rule = rule[1:]
        rule = rule.strip('/')
        if rule.startswith('**/'):
            pattern = rule[3:]
            matched = any(fnmatch.fnmatchcase('/'.join(path.split('/')[i:]), pattern)
                          for i in range(len(path.split('/'))))
        else:
            matched = fnmatch.fnmatchcase(path, rule) if '/' not in path else False
        if matched:
            result = not negate
    return result


class DockerContextSecretRegression(unittest.TestCase):
    def test_dotenv_and_variants_are_excluded_even_in_subdirectories(self):
        for path in ('.env', '.env.production', '.env.local', '.env.deploy',
                     'nested/.env', 'nested/.env.production', 'nested/deeper/.env.local'):
            with self.subTest(path=path):
                self.assertTrue(excluded(path), f'{path} enters the build context')
        self.assertFalse(excluded('src/config/runtime.ts'))

    def test_local_upload_directory_is_excluded_from_build_context(self):
        ignore = ROOT / '.dockerignore'
        rules = [line.strip() for line in ignore.read_text().splitlines()]
        # Require our root-anchored rule and conservatively disallow later
        # negations: wildcard negations can reinclude upload descendants.
        self.assertIn('data/uploads', rules)
        position = len(rules) - 1 - rules[::-1].index('data/uploads')
        self.assertFalse(any(rule.startswith('!') for rule in rules[position + 1:]))

    def test_upload_rule_rejects_later_descendant_reinclusion(self):
        from unittest.mock import patch
        fake_rules = 'data/uploads\n!data/uploads/**\n'
        with patch.object(Path, 'read_text', return_value=fake_rules):
            with self.assertRaises(AssertionError):
                self.test_local_upload_directory_is_excluded_from_build_context()

    def test_public_vite_configuration_is_explicitly_available_to_build(self):
        dockerfile = (ROOT / 'Dockerfile').read_text()
        build = dockerfile.index('RUN npm run build')
        for name in ('VITE_API_BASE_URL', 'VITE_SFU_URL', 'VITE_SB_URL',
                     'VITE_SB_ANON_PUB', 'VITE_SUPABASE_URL',
                     'VITE_SUPABASE_ANON_PUB', 'VITE_CFR2_PUBLIC_URL',
                     'VITE_CFR2_ACCOUNT_ID', 'VITE_CFR2_BUCKET', 'VITE_CFS3_BUCKET',
                     'VITE_ICE_STUN', 'VITE_SOCKET_IO_SIGNALING_URL',
                     'VITE_SIGNALING_WS_URL', 'VITE_SIGNALING_HTTP_URL',
                     'VITE_SIGNALING_TRANSPORT_URL'):
            with self.subTest(name=name):
                self.assertIn(f'ARG {name}\n', dockerfile[:build])
        self.assertNotIn('ARG VITE_TURN_CREDENTIAL', dockerfile)


if __name__ == '__main__':
    unittest.main()
