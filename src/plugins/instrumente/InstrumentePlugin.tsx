import React from 'react';
import { PluginBase } from '../PluginBase';
import { PluginLockable } from '../PluginLockable';
import { InstrumentsTerminal } from '../../components/InstrumentsTerminal';

export class InstrumentePlugin extends PluginLockable {
  config = { id: 'instrumente', name: 'Instrumente', colorScheme: 'brown' };
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
