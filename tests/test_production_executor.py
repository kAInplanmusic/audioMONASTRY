import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'services/audiomonastry-ai-runtime'))
import handlers_fleet2026 as handlers


class ExecutorContractTests(unittest.TestCase):
    def test_isolated_probe_never_passes_if_more_than_one_gpu_was_rented(self):
        result,report=self.run_priority_fixture(8,0)
        self.assertEqual(4,result);self.assertFalse(report['passed']);self.assertTrue(report['cleanupPassed'])

    def test_isolated_probe_requires_cleanup_even_after_fifty_commands_pass(self):
        result,report=self.run_priority_fixture(1,1)
        self.assertEqual(4,result);self.assertFalse(report['cleanupPassed'])

    def test_isolated_probe_passes_only_for_one_executor_and_confirmed_cleanup(self):
        result,report=self.run_priority_fixture(1,0)
        self.assertEqual(0,result);self.assertTrue(report['passed']);self.assertTrue(report['cleanupPassed'])

    def run_priority_fixture(self,created,cleanup_code):
        spec=importlib.util.spec_from_file_location('priority_qa_fixture',ROOT/'scripts/production/executor-priority-qa.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);state=base/'state';state.mkdir();output=base/'proof.json'
            def run(args):
                if args.command=='down':return cleanup_code
                (state/'state.json').write_text(json.dumps({'executorOnly':True,'allocationsEverCreated':created,
                    'instances':{'audio-brain':{'id':1}},'executorFunctionalPreflight':{'passed':True,'completed':50}}))
                return 0
            arguments=['priority','--plan',str(base/'plan'),'--images',str(base/'images'),
                '--state-dir',str(state),'--output',str(output)]
            with patch.object(sys,'argv',arguments), patch.dict(os.environ,{'GITHUB_RUN_ID':'43232153053'}), patch.object(module.vast,'run',side_effect=run):
                code=module.main()
            return code,json.loads(output.read_text())

    def test_typed_daw_response_is_untrusted_until_app_validation_and_plugin_lock(self):
        raw='{"commands":[{"pluginId":"transport","command":"set_tempo(128)"}]}'
        generate=Mock(return_value={'text':raw})
        with patch.dict(sys.modules,{'handlers_native':SimpleNamespace(generate_chat=generate)}):
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
        with patch.dict(sys.modules,{'handlers_native':SimpleNamespace(generate_chat=generate)}):
            with self.assertRaisesRegex(Exception,'catalog missing or invalid'):
                handlers.gui_execute('qwen3-4b',SimpleNamespace(),{'instruction':'hello','format':'daw_commands'})
        generate.assert_not_called()


if __name__=='__main__':unittest.main()
