import React, { useState, useEffect } from 'react';
import { PluginBase } from '../PluginBase';
import { PluginState, LockStatus, Plugin } from '../types';
import { hubConnector } from '../../hubConnector';
import { audioEngine } from '../../utils/audioEngine';
import { SPATIAL_SETUPS } from '../../utils/spatialMath';

export class SpatialSurroundPlugin implements Plugin {
  config = { id: 'spatial-surround', name: 'SpatialSurround', colorScheme: 'blue' };
  state: PluginState = 'OFF';
  lockStatus: LockStatus = { lockedBy: null, timestamp: 0, active: false };

  // Audio Kontext Integration
  private audioCtx: AudioContext | null = null;
  private currentPanner: AudioNode | null = null; // Can be AudioWorkletNode or StereoPannerNode
  private isWorkletPanner: boolean = false; // To track which panner is active
  private _posX: number = 0; // Stored X position (-1 to 1)
  private _posY: number = 0; // Stored Y position (-1 to 1)
  private _positionBuffer: ArrayBuffer | SharedArrayBuffer | null = null;
  private _positionBufferView: Float32Array | null = null;

  async init(ctx: AudioContext) {
    this.audioCtx = ctx;

    // Allocate SAB for position data (x, y)
    this._positionBuffer = typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(2 * Float32Array.BYTES_PER_ELEMENT) : new ArrayBuffer(2 * Float32Array.BYTES_PER_ELEMENT);
    this._positionBufferView = new Float32Array(this._positionBuffer);

    // Attempt to use AudioWorkletNode
    try {
      if (this.audioCtx && typeof AudioWorkletNode !== 'undefined' && this.audioCtx.audioWorklet) {
        // Worklet is now loaded centrally by AudioContext.tsx
        const workletPanner = new AudioWorkletNode(this.audioCtx, 'spatial-panner-processor');
        this.currentPanner = workletPanner;
        this.isWorkletPanner = true;
        // Pass SAB to the worklet
        if (this._positionBuffer) { // Ensure buffer is allocated
          workletPanner.port.postMessage({ buffer: this._positionBuffer });
        }
        // console.log("SpatialSurroundPlugin: Using AudioWorkletNode for panning.");
      } else {
        throw new Error("AudioWorkletNode not supported or context not available.");
      }
    } catch (error) {
      console.warn("SpatialSurroundPlugin: Failed to create AudioWorkletNode. Falling back to StereoPannerNode.", error);
      this.isWorkletPanner = false;
      if (this.audioCtx && typeof this.audioCtx.createStereoPanner === 'function') {
        this.currentPanner = this.audioCtx.createStereoPanner();
        // console.log("SpatialSurroundPlugin: Using StereoPannerNode for panning.");
      } else if (this.audioCtx) {
        // Fallback to a simple GainNode if StereoPannerNode is also not available (very old browsers)
        this.currentPanner = this.audioCtx.createGain();
        // console.log("SpatialSurroundPlugin: Using GainNode as fallback for panning.");
      } else {
        console.error("SpatialSurroundPlugin: No AudioContext available to create any panner.");
      }
    }

    // Connect the panner (assuming it's connected elsewhere in the audio graph)
    // For now, this.currentPanner will be available for connection by the system using this plugin.
  }

  // Helper to map x,y to pan value for StereoPannerNode
  private mapXYToPan(x: number, _y: number): number {
    // Simple mapping: x from -1 to 1 directly maps to pan from -1 (left) to 1 (right)
    // y could be used for volume adjustment if needed, but not for stereo pan.
    return x;
  }

  setPosition(x: number, y: number) {
    // Input Validation
    const safeX = Math.max(-1, Math.min(1, x));
    const safeY = Math.max(-1, Math.min(1, y));

    this._posX = safeX; // Store safe values
    this._posY = safeY;

    if (this.currentPanner) {
      if (this.isWorkletPanner && (this.currentPanner instanceof AudioWorkletNode)) {
        // Write to SAB instead of postMessage
        if (this._positionBufferView) {
            this._positionBufferView[0] = safeX;
            this._positionBufferView[1] = safeY;
        }
      } else if (!this.isWorkletPanner && (this.currentPanner instanceof StereoPannerNode)) {
        this.currentPanner.pan.setValueAtTime(this.mapXYToPan(safeX, safeY), this.audioCtx?.currentTime || 0);
      }
      // If it's a GainNode fallback, setPosition might not do anything or adjust volume.
      // For now, no action for GainNode fallback.
    }
  }

  getPosition(): { x: number; y: number } {
    return { x: this._posX, y: this._posY };
  }

  handleClock(_timestamp: number) {
    // Hier könnte Tempo-Synchronisation stattfinden
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

export const SpatialSurroundUI = React.memo(({ plugin, currentUserId }: {plugin: SpatialSurroundPlugin, currentUserId: string}) => {
  const [uiPosX, setUiPosX] = useState(0); // Normalized X (-1 to 1)
  const [uiPosY, setUiPosY] = useState(0); // Normalized Y (-1 to 1)
  const [setupId, setSetupId] = useState<string>(audioEngine.getSpatialSetupId?.() ?? '10.0');

  useEffect(() => {
    // Initialize UI position from plugin's current position
    const { x, y } = plugin.getPosition();
    setUiPosX(x);
    setUiPosY(y);

    const interval = setInterval(() => {
      const { x, y } = plugin.getPosition();
      setUiPosX(x);
      setUiPosY(y);
    }, 50); // Poll position periodically

    return () => clearInterval(interval);
  }, [plugin]);


  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1; // -1 to 1
    const y = ((e.clientY - rect.top) / rect.height) * 2 - 1; // -1 to 1
    plugin.setPosition(x, y);
    // Directly update local UI state for responsiveness
    setUiPosX(x);
    setUiPosY(y);
  };

  // Calculate pixel position for the dot
  const dotStyle = {
    left: `${(uiPosX + 1) / 2 * 100}%`, // Convert -1 to 1 range to 0% to 100%
    top: `${(uiPosY + 1) / 2 * 100}%`,  // Convert -1 to 1 range to 0% to 100%
  };

  return (
    <PluginBase
      name={plugin.config.name}
      state={plugin.state}
      lockStatus={plugin.lockStatus}
      currentUserId={currentUserId}
      onStateChange={(s) => plugin.updateState(s)}
      renderProUI={() => (
        <div className="w-full h-full flex flex-col gap-2 p-2">
          {/* Dropdown: Mehrkanal-Konfiguration 2/4.0/6/8/10/12/14/16/18.x */}
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-mono text-blue-400 uppercase tracking-widest whitespace-nowrap" htmlFor="spatial-setup">Setup</label>
            <select
              id="spatial-setup"
              value={setupId}
              onChange={(e) => {
                const id = e.target.value;
                setSetupId(id);
                audioEngine.setSpatialSetup(id);
              }}
              className="flex-1 bg-[#111] text-blue-300 border border-blue-700/40 rounded px-2 py-1 text-[10px] font-mono focus:outline-none"
            >
              {SPATIAL_SETUPS.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            <span className="text-[9px] text-neutral-500 font-mono">{setupId}</span>
          </div>

          {/* 2D-Pan-Fläche */}
          <div className="flex-1 bg-neutral-900 rounded border border-neutral-700 relative cursor-crosshair overflow-hidden" onMouseMove={handleMove}>
             <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,var(--tw-gradient-stops))] from-blue-900/20 to-transparent"></div>
             <div className="absolute inset-0 flex items-center justify-center text-[9px] font-mono text-neutral-600 pointer-events-none">
               {setupId} KANÄLE
             </div>
             {/* Blue dot reflecting position */}
             <div
               className="absolute w-4 h-4 bg-blue-500 rounded-full -translate-x-1/2 -translate-y-1/2 shadow-[0_0_10px_rgba(59,130,246,0.8)]"
               style={dotStyle}
             ></div>
          </div>
        </div>
      )}
    />
  );
});
