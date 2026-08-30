import React from 'react';
import { PluginBase } from '../PluginBase';
import { PluginState, LockStatus, Plugin } from '../types';
import { hubConnector } from '../../hubConnector';

export class SequencerPlugin implements Plugin {
  config = { id: 'sequenzer', name: 'Sequencer', colorScheme: 'green' };
  state: PluginState = 'OFF';
  lockStatus: LockStatus = { lockedBy: null, timestamp: 0, active: false };

  async requestLock(userId: string): Promise<boolean> {
    const success = await hubConnector.lockPlugin(this.config.id, userId);
    return success;
  }

  async releaseLock(userId: string): Promise<void> {
    await hubConnector.unlockPlugin(this.config.id, userId);
  }

  async updateState(newState: PluginState): Promise<void> {
    this.state = newState;
  }
}

export const SequencerUI = React.memo(({ plugin, currentUserId }: {plugin: SequencerPlugin, currentUserId: string}) => {
  return (
    <PluginBase
      name={plugin.config.name}
      state={plugin.state}
      lockStatus={plugin.lockStatus}
      currentUserId={currentUserId}
      onStateChange={(s) => plugin.updateState(s)}
      renderProUI={() => <div>Sequencer Advanced Interface</div>}
    />
  );
});
