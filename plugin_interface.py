from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import Any, ClassVar, Generic, Mapping, TypeVar


ConfigT = TypeVar("ConfigT")
StateT = TypeVar("StateT")


class PluginState(str, Enum):
    OFF = "OFF"
    AUTO_AI = "AUTO_AI"
    PRO = "PRO"


class PluginKind(str, Enum):
    SOURCE = "source"
    PROCESSOR = "processor"
    MIXER = "mixer"
    ROUTER = "router"
    CONTENT = "content"
    ANALYZER = "analyzer"
    RECORDER = "recorder"


@dataclass(frozen=True, slots=True)
class AudioBuffer:
    channels: tuple[tuple[float, ...], ...]
    sample_rate: int
    timestamp: float
    frame_count: int

    @property
    def channel_count(self) -> int:
        return len(self.channels)


@dataclass(frozen=True, slots=True)
class PluginCommand:
    name: str
    payload: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class PluginSnapshot:
    plugin_id: str
    state: PluginState
    parameters: Mapping[str, Any]
    data: Mapping[str, Any]


class PluginInterface(ABC, Generic[ConfigT, StateT]):
    """
    Sprachübergreifender Vertrag für audioMONASTRY-Plugins.

    Echtzeitregeln:
    - process() darf keinen Netzwerkzugriff ausführen.
    - process() darf keine Dateien lesen oder schreiben.
    - process() darf nicht auf Locks warten.
    - process() darf keine unkontrollierten großen Speicherallokationen ausführen.
    - asynchrone Arbeit gehört in initialize(), handle_command() oder externe Worker.
    """

    plugin_id: ClassVar[str]
    plugin_kind: ClassVar[PluginKind]
    version: ClassVar[str] = "1.0.0"

    def __init__(self, config: ConfigT):
        self.config = config
        self.state: PluginState = PluginState.OFF

    async def initialize(self, context: Any) -> None:
        return None

    def set_state(self, state: PluginState) -> None:
        self.state = state

    def process(self, audio: AudioBuffer) -> AudioBuffer:
        if self.state == PluginState.OFF:
            return audio
        return audio

    @abstractmethod
    def set_parameter(self, name: str, value: Any) -> None:
        raise NotImplementedError

    async def handle_command(self, command: PluginCommand) -> Any:
        raise NotImplementedError(
            f"Plugin {self.plugin_id} does not support command {command.name!r}"
        )

    def snapshot(self) -> PluginSnapshot:
        return PluginSnapshot(
            plugin_id=self.plugin_id,
            state=self.state,
            parameters={},
            data={},
        )

    def restore(self, snapshot: PluginSnapshot) -> None:
        if snapshot.plugin_id != self.plugin_id:
            raise ValueError(
                f"Snapshot belongs to {snapshot.plugin_id}, "
                f"not {self.plugin_id}"
            )
        self.state = snapshot.state

    async def dispose(self) -> None:
        return None
