import React from 'react';
import type { SpatialSource } from '../types';

interface Props {
  source: SpatialSource;
  selected: boolean;
  onSelect: (id: number) => void;
  onDragMove: (id: number, x: number, y: number) => void;
  onDoubleClick: (id: number) => void;
}

/** Kleine, dragbare Quellen-Markierung für die 2D-Scene. */
export const SpatialSourceIcon: React.FC<Props> = ({ source, selected, onSelect, onDragMove, onDoubleClick }) => {
  const color = source.color ?? '#a78bfa';
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Quelle ${source.name}`}
      onClick={(e) => { e.stopPropagation(); onSelect(source.id); }}
      onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick(source.id); }}
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        onSelect(source.id);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 0) return;
        const rect = (e.currentTarget.parentElement as HTMLDivElement).getBoundingClientRect();
        const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
        onDragMove(source.id, nx, ny);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 5 : e.ctrlKey ? 15 : 1;
        const r = Math.min(0.9, source.dist / 2);
        if (e.key === 'ArrowLeft') onDragMove(source.id, (Math.max(-180, source.az - step)) / 90, Math.sin((source.az * Math.PI) / 180) * r);
        if (e.key === 'ArrowRight') onDragMove(source.id, (Math.min(180, source.az + step)) / 90, Math.sin((source.az * Math.PI) / 180) * r);
        if (e.key === 'ArrowUp') onDragMove(source.id, source.az / 90, Math.min(1, r + 0.05));
        if (e.key === 'ArrowDown') onDragMove(source.id, source.az / 90, Math.max(-1, r - 0.05));
      }}
      className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 cursor-grab active:cursor-grabbing transition-transform hover:scale-110 ${selected ? 'ring-2 ring-white/50 scale-110' : ''} ${source.muted ? 'opacity-30 grayscale' : ''}`}
      style={{
        width: 22,
        height: 22,
        backgroundColor: color,
        borderColor: selected ? '#fff' : 'rgba(255,255,255,0.35)',
        boxShadow: `0 0 14px ${color}88`,
      }}
    >
      <span className="absolute left-1/2 top-full mt-1 -translate-x-1/2 text-[8px] font-mono font-bold tracking-wider text-neutral-300 whitespace-nowrap pointer-events-none">
        {source.name}
      </span>
    </div>
  );
};
