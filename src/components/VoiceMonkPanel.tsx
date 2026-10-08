import { useState } from 'react';
import { voiceMonkService, type VoiceMonkService, type VoiceOptions } from '../core/voice/VoiceMonkService';
import { VOICE_PRESETS, getVoicePreset } from '../core/voice/voicePresets';
import type { SessionMediaItem } from '../core/session/SessionMediaStore';
import { AmCard, AmSeg } from './am/amUi';

const GENDER = [['male', 'männlich'], ['female', 'weiblich']] as const;
const CHARACTER = [['dark', 'dunkel'], ['bright', 'hell'], ['neutral', 'neutral']] as const;
const LOUDNESS = [['soft', 'leise'], ['normal', 'normal'], ['loud', 'laut']] as const;

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
    <div className="voice-monk-panel am-rackrow am-a-voice2">
      <AmCard title="Presets" style={{ width: 190 }}>
        <div className="am-list am-a-scroll" role="listbox" aria-label="Voice-Preset">
          {VOICE_PRESETS.map((p) => (
            <button key={p.id} type="button" role="option" aria-selected={presetId === p.id} className={presetId === p.id ? 'am-on' : ''} onClick={() => applyPreset(p.id)}>
              <span className="am-a-ell">{p.name}</span><i>{p.language}</i>
            </button>
          ))}
        </div>
      </AmCard>

      <AmCard title="Text" style={{ flex: 1, minWidth: 280 }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Text für Stimme oder Gesang"
          aria-label="Text für Stimme oder Gesang"
          className="am-libq am-a-ta"
        />
        <div className="am-hint">
          {items.length === 0 ? 'Noch keine Medien in der Session.' : `${items.length} Medium/Medien in der Session-Datenbank.`}
        </div>
      </AmCard>

      <AmCard title="Stimme" style={{ width: 330 }}>
        <div className="am-a-grid3">
          <span className="am-lbl">Stimme</span>
          <AmSeg<'male' | 'female'> label="Stimme" value={gender} options={GENDER} onChange={setGender} />
          <span className="am-lbl">Charakter</span>
          <AmSeg<'dark' | 'bright' | 'neutral'> label="Charakter" value={character} options={CHARACTER} onChange={setCharacter} />
          <span className="am-lbl">Lautstärke</span>
          <AmSeg<'soft' | 'normal' | 'loud'> label="Lautstärke" value={loudness} options={LOUDNESS} onChange={setLoudness} />
        </div>
      </AmCard>

      <AmCard title="Erzeugen" style={{ width: 210 }}>
        <div className="am-a-btn2">
          <button type="button" onClick={handleSpeak} disabled={busy} className="am-btn am-pri">Sprechen</button>
          <button type="button" onClick={handleSing} disabled={busy} className="am-btn am-pri">Singen</button>
          <button type="button" onClick={handleSong} disabled={busy} className="am-btn">Song</button>
          <button type="button" onClick={() => service.preview(text, options)} className="am-btn">Live-Vorschau</button>
        </div>
      </AmCard>
    </div>
  );
}
