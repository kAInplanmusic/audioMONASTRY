export type ProtocolMessageType = 
  | 'PLUGIN_STATE_UPDATE'
  | 'FX_UPDATE'
  | 'MIDI_CC'
  | 'AUDIO_SYNC'
  | 'CLOCK_PING'
  | 'CLOCK_PONG'
  | 'LATENCY_PING'
  | 'LATENCY_PONG'
  | 'SCRATCHPAD_UPDATE';

export interface BaseMessage {
  type: ProtocolMessageType;
  senderId: string;
  timestamp: number;
}

export interface PluginStateMessage extends BaseMessage {
  type: 'PLUGIN_STATE_UPDATE';
  pluginId: string;
  state: 'OFF' | 'AUTO_AI' | 'PRO';
}

export interface FXUpdateMessage extends BaseMessage {
  type: 'FX_UPDATE';
  fx_type: string;
  settings: { wetDry: number };
  sample_id?: string;
}

export type WebRTCMessage =
  | PluginStateMessage
  | FXUpdateMessage
  | {
      type: 'CLOCK_PING' | 'CLOCK_PONG' | 'LATENCY_PING' | 'LATENCY_PONG' | 'SCRATCHPAD_UPDATE';
      [key: string]: any;
    };
