import React from 'react';
import { SemanticSampleSearch } from './SemanticSampleSearch';
import { Scratchpad } from './Scratchpad';
import { AudioSample } from '../data/samples';

interface SampleModuleWrapperProps {
  onSelect: (sample: AudioSample) => void;
  children: React.ReactNode;
}

export const SampleModuleWrapper: React.FC<SampleModuleWrapperProps> = ({ onSelect, children }) => {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-4 bg-black/20 p-2 rounded-lg border border-neutral-800">
        <SemanticSampleSearch onSelect={onSelect} />
        <Scratchpad />
      </div>
      <div className="flex-1">
        {children}
      </div>
    </div>
  );
};
