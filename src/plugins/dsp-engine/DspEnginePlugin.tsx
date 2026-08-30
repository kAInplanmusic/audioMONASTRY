import React from 'react';
import { PluginBase } from '../PluginBase';
import { PluginState, LockStatus, Plugin } from '../types';
import { hubConnector } from '../../hubConnector';

export class DspEnginePlugin implements Plugin {
  config = { id: 'dsp-engine', name: 'DSP Engine', colorScheme: 'orange' };
  state: PluginState = 'OFF';
  autoMode: boolean = true; // Default: Automatikmodus an
  lockStatus: LockStatus = { lockedBy: null, timestamp: 0, active: false };

  private audioCtx: AudioContext | null = null;
  private filter: BiquadFilterNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;

  async init(ctx: AudioContext) {
    this.audioCtx = ctx;
    // Standard: Transparente Filterkette (Bypass-ähnlich)
    this.filter = this.audioCtx.createBiquadFilter();
    this.filter.type = 'allpass'; // Transparent
    this.compressor = this.audioCtx.createDynamicsCompressor();
    this.compressor.threshold.setValueAtTime(-100, this.audioCtx.currentTime); // Off
  }

  handleClock(_timestamp: number) {
    if (this.autoMode) {
      // KI-Steuerung via Hub: Hier könnte der Hub-Guardian
      // dynamische Werte für Threshold/Ratio/Filter senden
    }
  }

  toggleAutoMode() {
    this.autoMode = !this.autoMode;
    // console.log(`DSP AutoMode: ${this.autoMode ? 'ON' : 'OFF'}`);
  }

  async requestLock(userId: string): Promise<boolean> {
    const success = await hubConnector.lockPlugin(this.config.id, userId);
    if (success) {
      this.lockStatus = { lockedBy: userId, timestamp: Date.now(), active: true };
    }
    return success;
  }

  async releaseLock(userId: string): Promise<void> {
    await hubConnector.unlockPlugin(this.config.id, userId);
    this.lockStatus = { lockedBy: null, timestamp: 0, active: false };
  }

  async updateState(newState: PluginState): Promise<void> {
    this.state = newState;
  }
}

export const DspEngineUI = React.memo(({ plugin, currentUserId }: {plugin: DspEnginePlugin, currentUserId: string}) => {
  return (
    <PluginBase
      name={plugin.config.name}
      state={plugin.state}
      lockStatus={plugin.lockStatus}
      currentUserId={currentUserId}
      onStateChange={(s) => plugin.updateState(s)}
      renderProUI={() => (
        <div className="flex flex-col gap-2">
          <div>DSP Advanced Interface</div>
          <button type="button"
              onClick={() => plugin.toggleAutoMode()}
              className={`p-2 rounded border ${plugin.autoMode ? 'bg-orange-600' : 'bg-neutral-800'}`}
          >
              AUTO-MODE {plugin.autoMode ? 'ON' : 'OFF'}
          </button>
          <p className="text-[10px] text-neutral-500"> DSP-Engine ist transparent (Bypass) bis KI-Regelung aktiv.</p>
        </div>
      )}
    />
  );
});
