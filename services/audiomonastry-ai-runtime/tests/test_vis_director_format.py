"""gui.execute format 'vis_director': eine Zeile Vorschlag vom kleinen Modell, nichts wird ausgefuehrt."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import handlers_fleet2026 as fleet
import handlers_native
from model_manager import ModelDefinition
from registry import read_manifest


def definition(model_id):
    return ModelDefinition.from_dict(next(m for m in read_manifest()['models'] if m['id'] == model_id))


class VisDirectorFormatTests(unittest.TestCase):
    def run_format(self, payload, reply='{"look":{"effects":"auto"}}'):
        with patch.object(handlers_native, 'generate_chat', return_value={'text': reply}) as chat:
            result = fleet.gui_execute('qwen3-4b', definition('qwen3-4b'), payload)
        return result, chat

    def test_returns_the_raw_proposal_and_never_executes(self):
        result, chat = self.run_format({'format': 'vis_director', 'instruction': 'energy 0.8, section drop', 'maxTokens': 300})
        self.assertEqual('{"look":{"effects":"auto"}}', result['text'])
        self.assertFalse(result['executed'])
        self.assertTrue(result['requiresAppValidation'])
        kwargs = chat.call_args.kwargs
        self.assertEqual(300, kwargs['max_new_tokens'])
        self.assertEqual(0, kwargs['temperature'])
        self.assertFalse(kwargs['do_sample'])
        self.assertIn('Never execute code', chat.call_args.args[2][0]['content'])

    def test_token_budget_is_bounded(self):
        _, chat = self.run_format({'format': 'vis_director', 'instruction': 'x', 'maxTokens': 100000})
        self.assertEqual(512, chat.call_args.kwargs['max_new_tokens'])
        _, chat = self.run_format({'format': 'vis_director', 'instruction': 'x', 'maxTokens': 1})
        self.assertEqual(64, chat.call_args.kwargs['max_new_tokens'])

    def test_instruction_must_be_present_and_bounded(self):
        for bad in ('', 'x' * 3001):
            with self.assertRaises(Exception):
                self.run_format({'format': 'vis_director', 'instruction': bad})

    def test_other_formats_keep_their_trust_checks(self):
        with self.assertRaises(Exception):
            self.run_format({'instruction': 'do things'})   # allowedCommands missing


if __name__ == '__main__':
    unittest.main()
