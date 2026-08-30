import React from 'react';
import { PluginState, LockStatus } from './types';

interface PluginBaseProps {
  name: string;
  state: PluginState;
  lockStatus: LockStatus;
  currentUserId: string;
  onStateChange: (state: PluginState) => void;
  renderProUI: () => React.ReactNode;
}

export const PluginBase: React.FC<PluginBaseProps> = ({ name, state, lockStatus, currentUserId, onStateChange, renderProUI }) => {
  const isLockedByOther = lockStatus.active && lockStatus.lockedBy !== currentUserId;

  return (
    <div className={`p-4 border rounded shadow ${isLockedByOther ? 'opacity-50 grayscale' : ''}`}>
      <div className="flex justify-between items-center mb-2">
        <h2 className="text-lg font-bold">{name}</h2>
        {isLockedByOther ? (
            <span className="text-xs bg-red-900 text-red-200 px-2 py-1 rounded">LOCKED BY {lockStatus.lockedBy}</span>
        ) : (
            <select value={state} onChange={(e) => onStateChange(e.target.value as PluginState)} className="bg-black text-white text-xs p-1 rounded">
                <option value="OFF">OFF</option>
                <option value="AUTO_AI">AI</option>
                <option value="PRO">ACTIVE</option>
            </select>
        )}
      </div>
      <div className="mt-4">{renderProUI()}</div>
    </div>
  );
};
