import React from 'react';
import { ClipboardCopy, Trash2 } from 'lucide-react';
import { useProject } from '../context/ProjectContext';
import { DropTarget } from './DropTarget';
import { openAudioActionMenu } from './AudioActionMenuHost';
import { clipboardEntryToContent, sampleToContent } from '../core/audio/audioContent';

/**
 * Project Clipboard – gemeinsames, projektweites Clipboard.
 * Referenziert vorhandene Audio-Assets (keine Audio-Duplikate) und wird über
 * den bestehenden Kollaborations-Kanal synchronisiert (ProjectContext).
 */
export const Scratchpad: React.FC = () => {
  const { clipboard, addClipboardItem, removeClipboardItem } = useProject();

  return (
    <div className="relative group">
      <button type="button" className="flex items-center gap-2 bg-[#1a1a1a] border border-neutral-800 rounded-lg p-2 hover:border-fuchsia-500 transition-colors cursor-pointer">
        <ClipboardCopy className="w-4 h-4 text-fuchsia-400" />
        <span className="text-[10px] font-bold text-fuchsia-200">CLIPBOARD ({clipboard.length})</span>
      </button>

      {/* Flyout panel */}
      <div className="absolute top-full mt-2 right-0 w-72 bg-[#111] border border-neutral-800 rounded-lg shadow-2xl p-4 hidden group-hover:block z-50">
        <h4 className="text-[10px] font-bold text-neutral-500 uppercase mb-1">Project Clipboard</h4>
        <p className="text-[9px] font-mono text-neutral-600 mb-3">Gemeinsam für alle User · verweist auf Audio-Assets</p>
        <DropTarget
            onDrop={(sample) => addClipboardItem(sampleToContent(sample, 'clipboard-drop'))}
            className="border-2 border-dashed border-neutral-800 rounded-lg p-3 text-center text-[10px] text-neutral-600 mb-3 hover:border-fuchsia-500"
        >
            AUDIO HIERHER ZIEHEN
        </DropTarget>
        <div className="space-y-1.5 max-h-52 overflow-y-auto">
            {clipboard.length === 0 && (
              <div className="text-[10px] font-mono text-neutral-600 text-center py-3">
                Noch keine Einträge – Audio anklicken → „Copy to Project Clipboard“.
              </div>
            )}
            {clipboard.map(item => (
                <div key={item.id} className="flex items-center justify-between gap-2 bg-[#1a1a1a] p-2 rounded text-[10px] font-mono">
                    <button
                      type="button"
                      onClick={(e) => openAudioActionMenu(clipboardEntryToContent(item), e.currentTarget)}
                      className="truncate flex-1 text-left text-neutral-200 hover:text-fuchsia-300 cursor-pointer"
                      title={`${item.name} – Aktionen öffnen`}
                    >
                      {item.name}
                    </button>
                    <button type="button" onClick={() => removeClipboardItem(item.id)} className="text-red-500 hover:text-red-300 shrink-0 cursor-pointer" aria-label={`${item.name} entfernen`}>
                      <Trash2 className="w-3 h-3" />
                    </button>
                </div>
            ))}
        </div>
      </div>
    </div>
  );
};
