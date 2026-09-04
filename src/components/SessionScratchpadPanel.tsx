import React, { useEffect, useState } from 'react';
import { ClipboardCopy, Trash2, X } from 'lucide-react';
import {
  MONK_DRAG_MIME,
  MONK_SCRATCH_MIME,
  readMonkDragItem,
  addScratchpadEntry,
  addScratchpadSnapshot,
  loadScratchpadEntries,
  loadScratchpadSnapshots,
  removeScratchpadEntry,
  removeScratchpadSnapshot,
  type ScratchpadEntry,
  type SessionScratchpadItem,
} from '../core/session/sessionScratchpad';

interface SessionScratchpadPanelProps {
  open: boolean;
  onClose: () => void;
  /** Liefert den aktuellen Session-Zustand als Scratchpad-Item. */
  onSaveSnapshot: (name: string) => SessionScratchpadItem;
  /** Wendet einen gespeicherten Snapshot auf die Session an. */
  onLoadSnapshot: (item: SessionScratchpadItem) => void;
}

/**
 * P1-4 (D9): Session-Zwischenspeicher als halbtransparente Overlay-Sidebar
 * (Desktop) bzw. Overlay auf Mobile. Amber/orange als eigene Farbe.
 *
 *  - Snapshot-Liste: speichern (Name), laden, löschen (IndexedDB)
 *  - DnD: Plugins/Tracks in die Drop-Zone ziehen; Einträge aus dem
 *    Scratchpad heraus auf Module ziehen (MONK_SCRATCH_MIME)
 */
export const SessionScratchpadPanel: React.FC<SessionScratchpadPanelProps> = ({
  open,
  onClose,
  onSaveSnapshot,
  onLoadSnapshot,
}) => {
  const [snapshots, setSnapshots] = useState<SessionScratchpadItem[]>([]);
  const [entries, setEntries] = useState<ScratchpadEntry[]>([]);
  const [name, setName] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const [snaps, ents] = await Promise.all([loadScratchpadSnapshots(), loadScratchpadEntries()]);
      if (cancelled) return;
      setSnapshots(snaps);
      setEntries(ents);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const item = onSaveSnapshot(trimmed);
    setSnapshots(await addScratchpadSnapshot(item));
    setName('');
  };

  const handleLoad = (item: SessionScratchpadItem) => {
    onLoadSnapshot(item);
    onClose();
  };

  const handleDelete = async (id: string) => {
    setSnapshots(await removeScratchpadSnapshot(id));
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const item = readMonkDragItem(e, MONK_DRAG_MIME);
    if (!item) return;
    setEntries(await addScratchpadEntry(item));
  };

  const handleEntryRemove = async (entry: ScratchpadEntry) => {
    setEntries(await removeScratchpadEntry(entry.id, entry.type));
  };

  return (
    <div className="fixed inset-0 z-50 pointer-events-none" role="dialog" aria-label="Zwischenspeicher">
      {/* Overlay (Mobile/Desktop) – halbtransparent, Klick schließt */}
      <button
        type="button"
        aria-label="X"
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm pointer-events-auto cursor-default"
      />
      <aside className="absolute right-0 top-0 h-full w-[min(380px,92vw)] bg-black/70 backdrop-blur-xl border-l border-amber-400/25 shadow-[0_0_60px_-20px_rgba(251,191,36,0.35)] pointer-events-auto flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-amber-400/20">
          <div className="flex items-center gap-2">
            <ClipboardCopy className="w-4 h-4 text-amber-400" />
            <h2 className="text-xs font-black uppercase tracking-[0.25em] text-amber-200">Zwischenspeicher</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="p-1.5 rounded-md text-neutral-400 hover:text-amber-300 hover:bg-amber-400/10 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Session-Snapshot speichern */}
          <section>
            <h3 className="text-[10px] font-bold text-amber-300/90 uppercase tracking-widest mb-2">Snapshot</h3>
            <div className="flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleSave();
                }}
                placeholder="Name"
                className="flex-1 px-3 py-2 rounded-lg bg-black/60 border border-neutral-800 text-neutral-200 text-xs placeholder:text-neutral-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
              />
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!name.trim()}
                className="px-3 py-2 rounded-lg bg-amber-400/15 border border-amber-400/50 text-amber-300 text-[10px] font-bold uppercase tracking-widest hover:bg-amber-400/25 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                Speichern
              </button>
            </div>
            <div className="mt-2 space-y-1.5">
              {snapshots.length === 0 && (
                <p className="text-[10px] font-mono text-neutral-600">Keine Snapshots.</p>
              )}
              {snapshots.map((item) => (
                <div key={item.id} className="flex items-center gap-2 bg-black/40 border border-neutral-800 rounded-lg p-2">
                  <button
                    type="button"
                    onClick={() => handleLoad(item)}
                    className="flex-1 text-left min-w-0 cursor-pointer"
                  >
                    <div className="text-[11px] font-bold text-neutral-200 truncate">{item.name}</div>
                    <div className="text-[9px] font-mono text-neutral-500">
                      {item.snapshot.bpm} BPM · {Object.values(item.snapshot.moduleStates).filter((s) => s !== 'OFF').length} aktiv
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(item.id)}
                    aria-label={`${item.name} löschen`}
                    className="text-red-400/80 hover:text-red-300 cursor-pointer shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* DnD-Einträge */}
          <section>
            <h3 className="text-[10px] font-bold text-amber-300/90 uppercase tracking-widest mb-2">Ablage</h3>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }}
              onDrop={(e) => void handleDrop(e)}
              className="border-2 border-dashed border-amber-400/30 rounded-lg p-3 text-center text-[10px] text-neutral-500 hover:border-amber-400/70 hover:bg-amber-400/5 transition-colors"
            >
              HIERHER ZIEHEN
            </div>
            <div className="mt-2 space-y-1.5">
              {entries.length === 0 && (
                <p className="text-[10px] font-mono text-neutral-600">Keine Einträge.</p>
              )}
              {entries.map((entry) => (
                <div
                  key={`${entry.type}-${entry.id}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(MONK_SCRATCH_MIME, JSON.stringify(entry));
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  className="flex items-center gap-2 bg-black/40 border border-neutral-800 rounded-lg p-2 cursor-grab active:cursor-grabbing"
                  
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-bold text-amber-100 truncate">{entry.name}</div>
                    <div className="text-[9px] font-mono text-neutral-500 uppercase">
                      {entry.type}
                      {entry.state ? ` · ${entry.state}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleEntryRemove(entry)}
                    aria-label={`${entry.name} entfernen`}
                    className="text-red-400/80 hover:text-red-300 cursor-pointer shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
};
