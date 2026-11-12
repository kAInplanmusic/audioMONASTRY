import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'services/audiomonastry-ai-runtime'))
import handlers_fleet2026 as handlers


class ExecutorContractTests(unittest.TestCase):
    def test_typed_daw_response_is_untrusted_until_app_validation_and_plugin_lock(self):
        raw='{"commands":[{"pluginId":"transport","command":"set_tempo(128)"}]}'
        generate=Mock(return_value={'text':raw})
        with patch.dict(sys.modules,{'handlers_runpod':SimpleNamespace(generate_chat=generate)}):
            result=handlers.gui_execute('qwen3-4b',SimpleNamespace(),{
                'instruction':'Set tempo 128','format':'daw_commands',
                'allowedPluginCommands':{'transport':'set_tempo(bpm), play, stop'}})
        self.assertEqual(raw,result['text'])
        self.assertFalse(result['executed'])
        self.assertTrue(result['requiresAppPermissionCheck'])
        self.assertTrue(result['requiresPluginLock'])
        self.assertFalse(generate.call_args.kwargs['enable_thinking'])

    def test_missing_trusted_catalog_fails_before_model_call(self):
        generate=Mock()
        with patch.dict(sys.modules,{'handlers_runpod':SimpleNamespace(generate_chat=generate)}):
            with self.assertRaisesRegex(Exception,'catalog missing or invalid'):
                handlers.gui_execute('qwen3-4b',SimpleNamespace(),{'instruction':'hello','format':'daw_commands'})
        generate.assert_not_called()


if __name__=='__main__':unittest.main()
