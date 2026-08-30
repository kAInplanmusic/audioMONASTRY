import React from 'react';
import { PluginBase } from '../PluginBase';
import { PluginState, LockStatus, Plugin } from '../types';
import { hubConnector } from '../../hubConnector';
import { InstrumentsTerminal } from '../../components/InstrumentsTerminal';

export class InstrumentePlugin implements Plugin {
  config = { id: 'instrumente', name: 'Instrumente', colorScheme: 'brown' };
  state: PluginState = 'OFF';
  lockStatus: LockStatus = { lockedBy: null, timestamp: 0, active: false };

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

export const InstrumenteUI = React.memo(({ plugin, currentUserId }: {plugin: InstrumentePlugin, currentUserId: string}) => {
  return (
    <PluginBase
      name={plugin.config.name}
      state={plugin.state}
      lockStatus={plugin.lockStatus}
      currentUserId={currentUserId}
      onStateChange={(s) => plugin.updateState(s)}
      renderProUI={() => (
        <div className="w-full h-full min-h-[420px] bg-[#161616]">
          <InstrumentsTerminal />
        </div>
      )}
    />
  );
});
