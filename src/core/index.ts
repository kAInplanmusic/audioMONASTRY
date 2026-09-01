/**
 * audioMONASTRY · Core-Abstraktionen (Public API)
 * ----------------------------------------------
 * Zentral erreichbarer Einstiegspunkt der Phase-1-Abstraktionsschichten und
 * der erweiterten Kern-Bausteine (WebGPU, Worker-Pool, SFU, instrumentMONK).
 */
export * from './interfaces';
export { WebAudioBackend, webAudioBackend } from './WebAudioBackend';
export {
  WebRTCTransport, webRTCTransport,
  AIRuntime, aiRuntime,
  ComputeBackend, computeBackend,
  SpatialRenderer, spatialRenderer,
  WebMIDIAdapter, webMIDIAdapter,
  HIDAdapter, hidAdapter,
  OSCAdapter, oscAdapter,
  createBackends,
} from './adapters';
export type { Backends } from './adapters';

// 1.1.4 – Spatial-Renderer (Stereo/Binaural/Multichannel)
export {
  StereoSpatialRenderer, stereoSpatialRenderer,
  BinauralSpatialRenderer, binauralSpatialRenderer,
  MultichannelSpatialRenderer, multichannelSpatialRenderer,
} from './spatial/spatialRenderers';

// 1.1.6 – Transport-Registry & LocalTransport
export {
  LocalTransport, localTransport,
  TransportRegistry, transportRegistry,
} from './transport/TransportRegistry';

// 1.2.1 – Objekt-Identitätssystem
export { ObjectRegistry, uuidV4 } from './session/ObjectRegistry';
export type { SessionObject } from './session/ObjectRegistry';

// 1.2.2 – State-Replication (CRDT/LWW/OR-Set)
export {
  LamportClock,
  entryForObject, tombstoneFor,
  mergeEntry, mergeEntries, applyReplicationToRegistry, converge,
} from './session/stateReplication';
export type { ReplicationEntry, ReplicationState } from './session/stateReplication';

// 1.2.3 – Lease-basiertes Locking (Heartbeat + Auto-Release)
export { LockManager, lockManager } from './session/locking';
export type { LeaseLock } from './session/locking';

// 1.2.4 – Deterministisches Random-Seed-Management
export {
  hashString, mulberry32, SeedManager, seedManager,
} from './session/seedManagement';
export type { SeedState } from './session/seedManagement';

// 2.1.1/2.2.4 – RingBuffer (SAB/SPSC)
export { RingBuffer } from './workers/RingBuffer';

// 2.1.2 – Worklet-/Prozessor-Pooling
export { ProcessorPool, processorPool } from './workers/WorkletPool';
export type { PooledProcessor } from './workers/WorkletPool';

// 2.2.2 – Async-Sandboxing (Live/Offline)
export { registerSandboxedTask, runOffline, runLive } from './workers/AsyncSandbox';
export type { SandboxedTask } from './workers/AsyncSandbox';

// 3.1.4 – Session-Snapshots & Delta-Kompression
export {
  createSnapshot, createDelta, applyDelta,
  serializeSnapshot, deserializeSnapshot,
} from './session/SessionSnapshot';
export type { SessionSnapshot, SessionDelta } from './session/SessionSnapshot';

// 5.1.x – Spatial-Szene, Ambisonics, HRTF-Interpolation
export { SpatialScene, spatialScene } from './spatial/SpatialScene';
export type { SceneSource } from './spatial/SpatialScene';
export { encodeAmbisonics, decodeAmbisonicsToRing } from './spatial/ambisonics';
export type { AmbisonicFrame } from './spatial/ambisonics';
export { HrtfInterpolator } from './spatial/hrtfInterpolator';
export type { HrtfPair } from './spatial/hrtfInterpolator';

// Raumplaner 12.x/18.x/24.x + Xonar-U7-Kanalzuordnung
export {
  planRoom, planAllSetups, assignXonarDevices, requiredXonarDevices, isXonarU7,
  XONAR_U7_CHANNELS, XONAR_U7_CHANNEL_NAMES, ROOM_PLAN_FAMILIES,
} from './spatial/roomPlanner';
export type { RoomDimensions, RoomPlan, SpeakerPlacement, XonarDeviceAssignment } from './spatial/roomPlanner';

// 5.2.2/7.2.x – Edge-DSP, Routing & Failover
export { EdgeDspClient, edgeDspClient } from './edge/EdgeDspClient';
export type { EdgeVectorFrame, EdgeStatusFrame } from './edge/EdgeDspClient';
export { EdgeRouter, edgeRouter } from './edge/EdgeRouter';
export type { EdgeNode } from './edge/EdgeRouter';
export { FailoverController, failoverController } from './edge/FailoverController';
export type { FailoverState } from './edge/FailoverController';

// 8.1.1 – Native-Audio-Abstraktion
export { StubNativeAudioBackend, nativeAudioBackend } from './native/NativeAudioBackend';
export type { NativeAudioBackend, NativeAudioDevice } from './native/NativeAudioBackend';

// 8.2.2/8.2.3 – Hardware-Simulator & Hotplug
export { HardwareSimulator, hardwareSimulator } from './hardware/HardwareSimulator';
export { HotplugManager, hotplugManager } from './hardware/HotplugManager';
export type { HardwareDevice, HardwareState, HotplugEvent, HotplugEventKind } from './hardware/HotplugManager';

// 8.2.4 – Control-Event-Abstraktion + Codecs (transportagnostisch)
export {
  controlMessageToEvent, eventToControlMessage, normalizeControlValue, nowMs,
} from './hardware/controlEvent';
export {
  MidiStreamParser, ParameterNumberParser, RpnParser,
  midiClock, midiStart, midiStop, midiContinue, midiSongPosition,
  midiPolyAftertouch, midiChannelAftertouch, rpn, nrpn,
} from './hardware/midiCodec';
export type { ParsedMidiEvent } from './hardware/midiCodec';
export {
  parseHidReportDescriptor, extractHidReportValues, normalizeRelative,
} from './hardware/hidReport';
export type { HidReportDescriptor, HidReportField, HidReportValue } from './hardware/hidReport';
export {
  encodeOscMessage, encodeOscBundle, encodeOscPacket,
  decodeOscMessage, decodeOscPacket, ntpTimetag, timetagToMs, parseControlAddress,
} from './hardware/oscCodec';
export type { OscArgument, OscMessage, OscBundle, OscPacket } from './hardware/oscCodec';
export {
  DeviceProfileStore, deviceProfileStore, buildProfileId, fingerprintMatches,
} from './hardware/deviceProfile';
export type { DeviceFingerprint, DeviceProfile, DeviceProfileSettings } from './hardware/deviceProfile';
export { HardwareDiagnostics, hardwareDiagnostics } from './hardware/diagnostics';
export type { HardwareEventKind, HardwareLogEntry } from './hardware/diagnostics';

// 8.2.5 – Mapping-Engine (ControlEvent → App-Parameter)
export { MappingEngine, ruleMatches } from './mapping/MappingEngine';
export type { MappingRule, MappingKind, MappedParameter } from './mapping/MappingEngine';
export { MappingStore, mappingStore } from './mapping/MappingStore';
export type { MappingBundle } from './mapping/MappingStore';

// 8.2.6 – MIDI 2.0 / UMP-Codec
export {
  parseUmpPacket, parseUmpMidi1ChannelVoice, parseUmpMidi2,
  encodeUmpMidi1ChannelVoice, encodeUmpMidi2NoteOn, encodeUmpMidi2NoteOff,
  encodeUmpMidi2Controller, encodeUmpMidi2PitchBend, encodeUmpMidi2ChannelPressure,
  midi1BytesToUmp, umpMidi1ToBytes, umpWordCount,
} from './hardware/ump';
export type { UmpPacket, ParsedUmp, UmpMidi2NoteOn, UmpMidi2Controller } from './hardware/ump';

// 8.2.7 – OSC-Bridge-Logik (OSC ↔ MIDI ↔ ControlEvent)
export {
  oscPacketToControlEvents, oscMessageToControlEvents, controlEventToOsc, midiBytesToBridgeOsc,
} from './hardware/oscBridge';
export type { BridgeMessage, BridgeOscMessage, BridgeMidiMessage } from './hardware/oscBridge';

// 8.2.8 – Native Runtime Audio Backend (cpal-IPC → IAudioDeviceBackend)
export { NativeRuntimeAudioBackend } from './audio/runtime/NativeRuntimeAudioBackend';
export type { NativeDeviceInfo } from './audio/runtime/NativeRuntimeClient';

// 8.3.x – Instrument-Canvas-Definitionen (View 3, spielbare Flächen)
export {
  INSTRUMENT_CANVAS_DEFS, canvasDefForInstrument, hitZone, zoneNote,
} from './instrument/canvasDefs';
export type { CanvasDef, CanvasZone, InstrumentCanvasKind } from './instrument/canvasDefs';

// 8.2.9 – ControlHub (Adapter-Registry + Event-Bus) & Translation-Layer
export { ControlHub, controlHub } from './hardware/ControlHub';
export type { ControlHubDeviceState } from './hardware/ControlHub';
export { TranslationLayer } from './hardware/translationLayer';
export type { TranslationRule, TranslationResult } from './hardware/translationLayer';

// R4 – WebGPU-Spatialization
export { spatialConvolve, cpuSpatialConvolve } from './gpu/SpatialConvKernel';
export type { SpatialConvJob } from './gpu/SpatialConvKernel';

// WebGPU-Beschleuniger (4.1.1)
export { WebGPUKernel, getGPUKernel } from './gpu/WebGPUKernel';

// Worker-Pool (2.2.2)
export { workerPool } from './workers/WorkerPool';
export { computeLocal } from './computeLocal';

// SFU / Kollaborations-Transport (3.1.1)
export { MediasoupTransport, sfuTransport } from './transport/MediasoupTransport';

// instrumentMONK: Instrumenten-Engine (Plugin #5)
export type { IInstrumentBackend } from './instrument/IInstrumentBackend';
export { InstrumentBackend, instrumentBackend } from './instrument/InstrumentBackend';
export { dispatchInstrumentControl, velocityToMidi } from './instrument/instrumentControl';
export {
  INSTRUMENT_CATALOG, getInstrument, listByCategory, catalogStats,
  ACOUSTIC_INSTRUMENTS, SYNTHESIS_INSTRUMENTS,
} from './instrument/catalog';
export {
  INSTRUMENT_PROGRAM_MAP, INSTRUMENT_TO_PROGRAM, PROGRAM_CHANGE_TABLE,
  getInstrumentByProgram, getProgramForInstrument, MAX_MIDI_PROGRAM,
} from './instrument/midiProgramMap';
export type {
  InstrumentDefinition, InstrumentPreset, InstrumentChannel,
  InstrumentCategory, SynthKind, NoteInput,
  SynthDef, FmDef, DrumDef, FxDef, AcousticDef,
} from './instrument/types';

// P0-2 – PluginAudioRouter (OFF = Signalkette trennen, Aktivierung = Einspeisung)
export {
  activatePlugin, deactivatePlugin, routeModuleState,
  getPluginRoute, listPluginRoutes, assertAllPluginIdsRegistered, PLUGIN_ROUTE_IDS,
} from './pluginAudioRouter';
export type { PluginActiveState, PluginRouteConfig } from './pluginAudioRouter';
