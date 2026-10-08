import React from 'react';
import { SemanticSampleSearch } from './SemanticSampleSearch';
import { Scratchpad } from './Scratchpad';
import { AudioSample } from '../data/samples';

interface SampleModuleWrapperProps {
  onSelect: (sample: AudioSample) => void;
  children?: React.ReactNode;
}

/**
 * Sample-Suche + Projekt-Clipboard als eine kompakte Zeile (Rack-Modul-Stil).
 * Wird in einer Karte des drumsamplerMONK eingesetzt; `children` stehen rechts daneben.
 */
export const SampleModuleWrapper: React.FC<SampleModuleWrapperProps> = ({ onSelect, children }) => {
  return (
    <div className="am-c-search">
      <div>
        <SemanticSampleSearch onSelect={onSelect} />
      </div>
      <Scratchpad />
      {children}
    </div>
  );
};
