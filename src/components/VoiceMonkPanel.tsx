import { useState } from 'react';
import { voiceMonkService, type VoiceMonkService, type VoiceOptions } from '../core/voice/VoiceMonkService';
import { VOICE_PRESETS, getVoicePreset } from '../core/voice/voicePresets';
import type { SessionMediaItem } from '../core/session/SessionMediaStore';

interface VoiceMonkPanelProps {
  userId: string;
  service?: VoiceMonkService;
}

/** VoiceMONK UI: Text → Stimme/Gesang → Session-Medien-Datenbank. */
export function VoiceMonkPanel({ userId, service = voiceMonkService }: VoiceMonkPanelProps) {
  const [text, setText] = useState('Hallo meine Freunde der Tanykultur');
  const [presetId, setPresetId] = useState(VOICE_PRESETS[0].id);
  const [gender, setGender] = useState<'male' | 'female'>(VOICE_PRESETS[0].options.gender ?? 'male');
  const [character, setCharacter] = useState<'dark' | 'bright' | 'neutral'>(VOICE_PRESETS[0].options.character ?? 'dark');
  const [loudness, setLoudness] = useState<'soft' | 'normal' | 'loud'>(VOICE_PRESETS[0].options.loudness ?? 'soft');
  const [items, setItems] = useState<SessionMediaItem[]>([]);
  const [busy, setBusy] = useState(false);

  const options: VoiceOptions = { gender, character, loudness, model: getVoicePreset(presetId)?.hfModel };

  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = getVoicePreset(id);
    if (!preset) return;
    setGender(preset.options.gender ?? 'male');
    setCharacter(preset.options.character ?? 'dark');
    setLoudness(preset.options.loudness ?? 'soft');
  };

  const handleSpeak = async () => {
    setBusy(true);
    try {
      await service.speak(userId, text, options);
      setItems(service.listForUser(userId));
    } finally {
      setBusy(false);
    }
  };

  const handleSing = async () => {
    setBusy(true);
    try {
      await service.sing(userId, {
        notes: [{ lyric: text, midi: 60 }],
        bpm: 120,
      });
      setItems(service.listForUser(userId));
    } finally {
      setBusy(false);
    }
  };

  const handleSong = async () => {
    setBusy(true);
    try {
      await service.generateSong(userId, text, { bpm: 120, style: 'dark-techno' });
      setItems(service.listForUser(userId));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="voice-monk-panel flex flex-col gap-3 p-4 rounded-xl border border-neutral-800 bg-[#111] text-neutral-200">
      <label className="text-xs text-neutral-400">
        Voice-Preset:
        <select value={presetId} onChange={(e) => applyPreset(e.target.value)} className="ml-2 bg-black border border-neutral-800 rounded px-2 py-1">
          {VOICE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="Text für Stimme oder Gesang"
        className="w-full bg-black border border-neutral-800 rounded-lg p-3 text-sm"
      />

      <div className="flex flex-wrap gap-3 text-xs">
        <label>
          Stimme:
          <select value={gender} onChange={(e) => setGender(e.target.value as 'male' | 'female')} className="ml-1 bg-black border border-neutral-800 rounded px-2 py-1">
            <option value="male">männlich</option>
            <option value="female">weiblich</option>
          </select>
        </label>
        <label>
          Charakter:
          <select value={character} onChange={(e) => setCharacter(e.target.value as 'dark' | 'bright' | 'neutral')} className="ml-1 bg-black border border-neutral-800 rounded px-2 py-1">
            <option value="dark">dunkel</option>
            <option value="bright">hell</option>
            <option value="neutral">neutral</option>
          </select>
        </label>
        <label>
          Lautstärke:
          <select value={loudness} onChange={(e) => setLoudness(e.target.value as 'soft' | 'normal' | 'loud')} className="ml-1 bg-black border border-neutral-800 rounded px-2 py-1">
            <option value="soft">leise</option>
            <option value="normal">normal</option>
            <option value="loud">laut</option>
          </select>
        </label>
      </div>

      <div className="flex gap-2">
        <button type="button" onClick={handleSpeak} disabled={busy} className="px-3 py-1.5 rounded bg-cyan-700 text-white text-xs font-bold disabled:opacity-50">
          Sprechen
        </button>
        <button type="button" onClick={handleSing} disabled={busy} className="px-3 py-1.5 rounded bg-fuchsia-700 text-white text-xs font-bold disabled:opacity-50">
          Singen
        </button>
        <button type="button" onClick={handleSong} disabled={busy} className="px-3 py-1.5 rounded bg-amber-700 text-white text-xs font-bold disabled:opacity-50">
          Song
        </button>
        <button type="button" onClick={() => service.preview(text, options)} className="px-3 py-1.5 rounded bg-neutral-800 text-xs font-bold">
          Live-Vorschau
        </button>
      </div>

      <div className="text-[10px] text-neutral-500">
        {items.length === 0 ? 'Noch keine Medien in der Session.' : `${items.length} Medium/Medien in der Session-Datenbank.`}
      </div>
    </div>
  );
}
