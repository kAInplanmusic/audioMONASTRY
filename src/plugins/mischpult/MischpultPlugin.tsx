import React from 'react';
import { Sliders, Volume2 } from 'lucide-react';

export const MischpultTerminal = React.memo(({ plugin: _plugin, currentUserId: _currentUserId }: {plugin: any, currentUserId: string}) => {
  const assignBus = (_chId: number, _bus: string) => {
    // Interaktion mit MasterEngine API
    // console.log(`Assigning ${chId} to ${bus}`);
  };

  return (
    <div className="flex flex-col bg-[#111] p-4 text-neutral-300">
      <div className="grid grid-cols-5 gap-4">
        {/* Beispiel für 5 Kanäle mit User-Bus-Routing */}
        {[1,2,3,4,5].map(ch => (
          <div key={ch} className="p-4 bg-neutral-900 border border-neutral-700">
            <h4 className="text-xs font-bold mb-2">CH {ch}</h4>
            <div className="flex flex-col gap-1">
              {['GLOBAL_MASTER', 'USER_1', 'USER_2', 'USER_3', 'USER_4'].map(bus => (
                <button type="button"
                  key={bus}
                  onClick={() => assignBus(ch, bus)}
                  className="text-[9px] bg-neutral-800 hover:bg-orange-600 rounded p-1"
                >
                  {bus}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});
