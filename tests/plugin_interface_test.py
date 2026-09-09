import unittest

from plugin_interface import (
    AudioBuffer,
    PluginCommand,
    PluginInterface,
    PluginKind,
    PluginSnapshot,
    PluginState,
)


class TestPluginContract(unittest.TestCase):
    def test_off_is_transparent(self):
        class TestPlugin(PluginInterface[dict, dict]):
            plugin_id = "test"
            plugin_kind = PluginKind.SOURCE

            def set_parameter(self, name, value):
                return None

        plugin = TestPlugin({})
        block = AudioBuffer(
            channels=((0.1, 0.2),),
            sample_rate=48000,
            timestamp=0.0,
            frame_count=2,
        )

        self.assertEqual(plugin.state, PluginState.OFF)
        self.assertEqual(plugin.process(block), block)

    def test_state_transitions(self):
        class TestPlugin(PluginInterface[dict, dict]):
            plugin_id = "test"
            plugin_kind = PluginKind.PROCESSOR

            def set_parameter(self, name, value):
                return None

        plugin = TestPlugin({})
        plugin.set_state(PluginState.AUTO_AI)
        self.assertEqual(plugin.state, PluginState.AUTO_AI)
        plugin.set_state(PluginState.PRO)
        self.assertEqual(plugin.state, PluginState.PRO)

    def test_snapshot_restore_roundtrip(self):
        class TestPlugin(PluginInterface[dict, dict]):
            plugin_id = "roundtrip"
            plugin_kind = PluginKind.MIXER

            def set_parameter(self, name, value):
                return None

        plugin = TestPlugin({})
        plugin.set_state(PluginState.PRO)
        snap = plugin.snapshot()
        self.assertIsInstance(snap, PluginSnapshot)
        self.assertEqual(snap.plugin_id, "roundtrip")
        self.assertEqual(snap.state, PluginState.PRO)

        plugin.set_state(PluginState.OFF)
        plugin.restore(snap)
        self.assertEqual(plugin.state, PluginState.PRO)

    def test_restore_rejects_foreign_snapshot(self):
        class TestPlugin(PluginInterface[dict, dict]):
            plugin_id = "a"
            plugin_kind = PluginKind.CONTENT

            def set_parameter(self, name, value):
                return None

        plugin = TestPlugin({})
        foreign = PluginSnapshot(
            plugin_id="b",
            state=PluginState.PRO,
            parameters={},
            data={},
        )
        with self.assertRaises(ValueError):
            plugin.restore(foreign)

    def test_command_not_supported_by_default(self):
        import asyncio

        class TestPlugin(PluginInterface[dict, dict]):
            plugin_id = "cmd"
            plugin_kind = PluginKind.ANALYZER

            def set_parameter(self, name, value):
                return None

        plugin = TestPlugin({})
        with self.assertRaises(NotImplementedError):
            asyncio.run(plugin.handle_command(PluginCommand(name="nope", payload={})))

    def test_audio_buffer_channel_count(self):
        block = AudioBuffer(
            channels=((0.1, 0.2), (0.3, 0.4)),
            sample_rate=48000,
            timestamp=0.0,
            frame_count=2,
        )
        self.assertEqual(block.channel_count, 2)


if __name__ == "__main__":
    unittest.main()
