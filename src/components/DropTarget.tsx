import React from 'react';
import { useSamples } from '../context/SampleContext';
import { AudioSample } from '../data/samples';

interface DropTargetProps {
  onDrop: (sample: AudioSample) => void;
  children: React.ReactNode;
  className?: string;
  label?: string;
}

/**
 * DropTarget – nimmt Samples per Drag&Drop (Desktop) ODER per Tap-to-Place
 * (Touch/iOS) an. Tap-to-Place: Sample in der Library antippen ("armieren"),
 * dann auf die Drop-Zone tippen. Es greift nur, wenn der Klick direkt auf der
 * Zone landet (nicht auf inneren Buttons), damit bestehende Step-Buttons
 * ungestört bleiben.
 */
export const DropTarget: React.FC<DropTargetProps> = ({ onDrop, children, className = '', label }) => {
  const { setSelectedSample, pendingSample, setPendingSample } = useSamples();

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    try {
      const data = JSON.parse(e.dataTransfer.getData('application/json'));
      onDrop(data);
      setSelectedSample(data);
      setPendingSample(null);
    } catch (err) {
      console.error("Invalid sample dropped", err);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleClick = (e: React.MouseEvent) => {
    // Nur direkte Klicks auf die Zone (nicht auf Kinder) platzieren das
    // armierte Sample – so bleiben Step-/Pad-Buttons bedienbar.
    if (pendingSample && e.target === e.currentTarget) {
      onDrop(pendingSample);
      setSelectedSample(pendingSample);
      setPendingSample(null);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={handleClick}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && pendingSample) {
          e.preventDefault();
          onDrop(pendingSample);
          setSelectedSample(pendingSample);
          setPendingSample(null);
        }
      }}
      className={`relative border-2 border-dashed rounded-lg transition-colors ${pendingSample ? 'border-fuchsia-500/80 bg-fuchsia-500/5' : 'border-neutral-700 hover:border-fuchsia-500'} ${className}`}
    >
      {label && <span className="absolute top-1 left-2 text-[8px] font-mono text-neutral-500 uppercase z-10 pointer-events-none">{label}</span>}
      {pendingSample && (
        <span className="absolute bottom-1 right-2 text-[8px] font-mono text-fuchsia-300 uppercase z-10 pointer-events-none animate-pulse">
          Tippen = einsetzen
        </span>
      )}
      {children}
    </div>
  );
};
