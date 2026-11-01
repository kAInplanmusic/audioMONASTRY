/** dropMONK – React Context & State Management
 * ===========================================
 * Zentrale State für Drop-UI · inkl. Pad-Parameter (pit/lvl/len), Loop-Level, Quantization
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import type { DropProfile, GeneratedDropProfile, DropPreset, ParameterTransformation } from '../core/drop';
import type { QuantizationType } from '../core/drop/types/DropProfile';
import type { AudioContext as DropAudioContextState } from '../core/drop';
import {
  dropPresetStore,
  dropContextAnalyzer,
  dropEngine,
  aiDropGenerator,
  mixerBridge,
  clockBridge,
  getDropAudioAdapter,
  requestAudioDrop,
  audioDropProfile,
  isAudioDropProfile,
  playAudioDrop,
  projectKeyForDrop,
} from '../core/drop';
import type { AudioDropProfile } from '../core/drop';
import { readPluginSettings } from '../utils/pluginSettings';
import { attachDropBridges } from '../utils/dropAudioBridge';

export type DropMode = 'generator' | 'dj_transition' | 'sampler_top';

/** Pad Categories gemäß Spec (drp.<cat>) */
export type PadCategory = 'all' | 'buildup' | 'breakdown' | 'transition' | 'fill' | 'tops' | 'ai' | 'preset' | 'audio' | 'loop';

/** Quantization Levels gemäß Spec (drp.q) */
export type QuantizationLevel = 'instant' | '1/4' | '1/2' | '1bar' | '2bar' | '4bar';

/** Pad Parameter-State (drp.<cat>.N.pit/lvl/len) */
export interface PadParameters {
  pitch: number;  // -2 .. +2 (Semitone, 0 = original)
  level: number;  // 0 .. 1 (Gain)
  length: number; // 0 .. 1 (Normalized Länge für Loops)
}

/** Loop Level State (drp.loop.N.lvl) */
export interface LoopState {
  enabled: boolean;
  levels: Record<string, number>; // channelId -> level 0..1
}

/** Konvertiert UI-Quantisierung (QuantizationLevel) zu Engine-Typ (QuantizationType) */
function toQuantizationType(level: QuantizationLevel): QuantizationType {
  if (level === 'instant') return 'instant';
  if (level === '1/4') return '1/4bar';
  if (level === '1/2') return '1/2bar';
  return level; // '1bar' | '2bar' | '4bar' sind identisch
}

interface ChatMessage {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: number;
  generatedProfile?: GeneratedDropProfile;
  confidence?: number;
}

export interface DropContextType {
  // State
  mode: DropMode;
  selectedProfile: DropProfile | null;
  suggestedProfiles: DropProfile[];
  aiSuggestions: GeneratedDropProfile[];
  isExecuting: boolean;
  executionProgress: number;
  chatHistory: ChatMessage[];
  selectedStartChannel?: string;
  selectedEndChannel?: string;
  transitionInProgress: boolean;
  presets: DropPreset[];
  favorites: DropPreset[];
  /** DROP-P1-001: hoerbare KI-Drops (Audio in der Bibliothek, Pad im Raster). */
  audioDrops: AudioDropProfile[];
  audioDropBusy: boolean;
  /** Letzte Status-/Fehlermeldung der Audio-Erzeugung (leer = nichts). */
  audioDropStatus: string;
  /** drp.q: Quantization Level */
  quantization: QuantizationLevel;
  /** drp.<cat>.N.pit/lvl/len: Pad Parameters per category */
  padParameters: Record<string, PadParameters>;
  /** drp.loop.N.lvl: Loop State */
  loopState: LoopState;

  // Actions
  setMode: (mode: DropMode) => void;
  selectProfile: (profile: DropProfile) => void;
  generateDrop: (prompt: string) => Promise<void>;
  /** DROP-P1-001: Audio-Drop mit xl-turbo (RP3) im Tempo/Tonart des Projekts. */
  generateAudioDrop: (prompt: string, bars?: 4 | 8 | 16) => Promise<void>;
  executeDrop: (profile: DropProfile, quantized?: boolean, channelId?: string, padParams?: { category: PadCategory; padIndex: number }) => Promise<void>;
  triggerDjTransition: (fromCh: string, toCh: string, profile?: DropProfile) => Promise<void>;
  savePreset: (profile: DropProfile, name: string, tags?: string[]) => Promise<void>;
  loadPreset: (id: string) => Promise<void>;
  toggleFavorite: (presetId: string) => Promise<void>;
  addChatMessage: (text: string, sender: 'user' | 'ai', profile?: GeneratedDropProfile) => void;
  clearChat: () => void;
  setSelectedChannels: (start?: string, end?: string) => void;
  /** drp.pit/lvl/len: Setze Pad Parameter (drp.<cat>.N.pit/lvl/len) */
  setPadParameter: (category: PadCategory, padIndex: number, param: 'pitch' | 'level' | 'length', value: number) => void;
  /** drp.q: Setze Quantization */
  setQuantization: (level: QuantizationLevel) => void;
  /** drp.loop.N.lvl: Setze Loop Level */
  setLoopLevel: (channelId: string, level: number) => void;
  /** drp.loop.N.lvl: Enable/Disable Loop */
  setLoopEnabled: (enabled: boolean) => void;
}

const DropContext = createContext<DropContextType | undefined>(undefined);

export const DropProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setMode] = useState<DropMode>('generator');
  const [selectedProfile, setSelectedProfile] = useState<DropProfile | null>(null);
  const [suggestedProfiles, setSuggestedProfiles] = useState<DropProfile[]>([]);
  const [aiSuggestions, setAiSuggestions] = useState<GeneratedDropProfile[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionProgress, setExecutionProgress] = useState(0);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [selectedStartChannel, setSelectedStartChannel] = useState<string>();
  const [selectedEndChannel, setSelectedEndChannel] = useState<string>();
  const [transitionInProgress, setTransitionInProgress] = useState(false);
  const [presets, setPresets] = useState<DropPreset[]>([]);
  const [favorites, setFavorites] = useState<DropPreset[]>([]);
  const [audioDrops, setAudioDrops] = useState<AudioDropProfile[]>([]);
  const [audioDropBusy, setAudioDropBusy] = useState(false);
  const [audioDropStatus, setAudioDropStatus] = useState('');

  // drp.q: Quantization Level
  const [quantization, setQuantizationState] = useState<QuantizationLevel>('4bar');
  // drp.<cat>.N.pit/lvl/len: Pad Parameters per category
  const [padParameters, setPadParameters] = useState<Record<string, PadParameters>>({});
  // drp.loop.N.lvl: Loop State
  const [loopState, setLoopState] = useState<LoopState>({ enabled: false, levels: {} });

  /** Setze Pad Parameter (drp.<cat>.N.pit/lvl/len) */
  const setPadParameter = useCallback((category: PadCategory, padIndex: number, param: 'pitch' | 'level' | 'length', value: number) => {
    const key = `${category}_${padIndex}`;
    setPadParameters((prev) => ({
      ...prev,
      [key]: {
        ...prev[key] ?? { pitch: 0, level: 1, length: 1 },
        [param]: value,
      },
    }));
  }, []);

  /** Setze Quantization (drp.q) */
  const setQuantization = useCallback((level: QuantizationLevel) => {
    setQuantizationState(level);
  }, []);

  /** Setze Loop Level (drp.loop.N.lvl) */
  const setLoopLevel = useCallback((channelId: string, level: number) => {
    setLoopState((prev) => ({
      ...prev,
      levels: { ...prev.levels, [channelId]: level },
    }));
  }, []);

  /** Setze Loop Enabled (drp.loop.N.lvl) */
  const setLoopEnabled = useCallback((enabled: boolean) => {
    setLoopState((prev) => ({ ...prev, enabled }));
  }, []);

  /** Realer Mix-Zustand (BPM, aktive Plugins, Kanäle, Energie + FFT-Spektrum). */
  const captureMixContext = useCallback((): DropAudioContextState => {
    const channels = mixerBridge.getCurrentMixerState().map((ch) => ({
      id: ch.id,
      level: ch.level,
      isMuted: ch.muted,
      isPanned: ch.pan,
      isSoloed: ch.soloed,
    }));

    // SSOT DSP-P2-003: echte FFT-Bänder, wenn ein Analyser liefert; ohne Audio
    // (Headless/Test/Plugin OFF) unverändert der Pegel-Weg über die Kanal-Fader.
    const energy = mixerBridge.getEnergyState();

    return dropContextAnalyzer.analyzeCurrentMix(
      clockBridge.getClockState().bpm,
      getDropAudioAdapter()?.getActivePluginIds() ?? [],
      channels,
      // Im Spektrum-Fall bleibt die Energie bewusst ungesetzt: der Analyzer
      // rechnet sie dann aus den Bändern (energySource 'spectrum') und nennt
      // die Herkunft. Im Pegel-Fall wird der bisherige Wert durchgereicht.
      energy.source === 'spectrum' ? undefined : energy.energy,
      undefined,
      '4/4',
      energy.spectrum,
    );
  }, []);

  // Initialize
  useEffect(() => {
    // Bridges an die audioEngine hängen (Mixer/Parameter/Clock).
    const detachBridges = attachDropBridges();

    const init = async () => {
      await dropPresetStore.initialize();
      const allPresets = await dropPresetStore.listPresets();
      const favs = await dropPresetStore.getFavorites();
      setPresets(allPresets);
      setFavorites(favs);

      // Vorschläge aus dem realen Mix-Zustand ableiten.
      const scored = dropContextAnalyzer.suggestDropProfiles(captureMixContext(), 5);
      setSuggestedProfiles(scored.map((s) => s.profile));
    };

    init().catch(console.error);

    // Setup Drop Engine Events
    dropEngine.on('onDropStarted', () => {
      setIsExecuting(true);
      setExecutionProgress(0);
    });

    dropEngine.on('onDropProgress', (progress: number) => {
      setExecutionProgress(progress);
    });

    dropEngine.on('onDropFinished', () => {
      setIsExecuting(false);
      setExecutionProgress(1);
    });

    return () => {
      dropEngine.stopAll();
      detachBridges();
    };
  }, [captureMixContext]);

  const selectProfile = useCallback((profile: DropProfile) => {
    setSelectedProfile(profile);
  }, []);

  // Deklaration VOR generateDrop verhindert den Use-before-declare-Fehler.
  const addChatMessage = useCallback(
    (text: string, sender: 'user' | 'ai', profile?: GeneratedDropProfile) => {
      const message: ChatMessage = {
        id: `msg_${Date.now()}`,
        sender,
        text,
        timestamp: Date.now(),
        generatedProfile: profile,
        confidence: profile?.confidence,
      };
      setChatHistory((prev) => [...prev.slice(-20), message]); // Keep last 20 messages
    },
    []
  );

  const generateDrop = useCallback(async (prompt: string) => {
    try {
      const context = captureMixContext();

      const generated = await aiDropGenerator.generateDropProfile({
        context,
        userPrompt: prompt,
        style: 'moderate',
      });

      setAiSuggestions((prev) => [...prev.slice(-2), generated]);
      addChatMessage(
        prompt,
        'user'
      );
      addChatMessage(
        `Generated "${generated.name}" (confidence: ${(generated.confidence * 100).toFixed(0)}%)`,
        'ai',
        generated
      );

      setSelectedProfile(generated);
    } catch (err) {
      console.error('Drop generation failed:', err);
      addChatMessage(
        `Error: ${err instanceof Error ? err.message : 'Generation failed'}`,
        'ai'
      );
    }
  }, [captureMixContext, addChatMessage]);

  /**
   * DROP-P1-001: hoerbarer Drop. Tempo aus der Master-Clock (ClockBridge),
   * Tonart aus dem Mixer-Stand der Session (gleich auf allen Geraeten). Der
   * Server prueft den Lock (nur Halter), nutzt seinen Cache und legt das
   * Ergebnis still in die Bibliothek; hier entsteht nur das Pad.
   */
  const generateAudioDrop = useCallback(async (prompt: string, bars: 4 | 8 | 16 = 8) => {
    const text = prompt.trim();
    if (!text) return;
    setAudioDropBusy(true);
    setAudioDropStatus('Audio-Drop wird erzeugt (xl-turbo, RP3) …');
    try {
      const bpm = clockBridge.getClockState().bpm;
      const key = projectKeyForDrop((readPluginSettings('mixer') as { desk?: { key?: unknown } } | null)?.desk?.key);
      const result = await requestAudioDrop(
        { prompt: text, bpm, key, bars },
        { onStatus: setAudioDropStatus },
      );
      const profile = audioDropProfile(result, text);
      setAudioDrops((prev) => [...prev.filter((p) => p.id !== profile.id).slice(-7), profile]);
      setSelectedProfile(profile);
      setAudioDropStatus(`${result.cached ? 'Aus dem Cache' : 'Erzeugt'}: „${result.name}" – in der Bibliothek, Pad unter „KI & Presets".`);
    } catch (err) {
      setAudioDropStatus(`Audio-Drop fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAudioDropBusy(false);
    }
  }, []);

  const executeDrop = useCallback(async (
    profile: DropProfile,
    quantized = false,
    channelId = 'channel1',
    padParams?: { category: PadCategory; padIndex: number }
  ) => {
    // DROP-P1-001: Audio-Drop spielt ueber den Einspiel-Weg (Bar-genau bei quantized).
    if (isAudioDropProfile(profile)) {
      const ok = await playAudioDrop(profile, channelId, quantized);
      if (!ok) setAudioDropStatus('Audio-Drop nicht abspielbar (kein Audio-Weg oder Kanal ungueltig).');
      return;
    }
    try {
      // drp.<cat>.N.pit/lvl/len: Pad-Parameter-State an die Engine synchronisieren
      dropEngine.setPadParameters(padParameters);
      // drp.q: UI-Quantisierung an den Drop-Modus übergeben
      const dropMode = quantization === 'instant' ? 'quantized' : (quantized ? 'quantized' : 'immediate');
      const dropQuant = quantization === 'instant' ? undefined : toQuantizationType(quantization);
      await dropEngine.triggerDrop(
        profile,
        dropMode,
        dropQuant,
        undefined,
        padParams
      );

      // Registriere Usage
      if ('id' in profile && profile.id.startsWith('preset_')) {
        await dropPresetStore.recordUsage(profile.id);
      }
    } catch (err) {
      console.error('Drop execution failed:', err);
    }
  }, [padParameters]);

  const triggerDjTransition = useCallback(
    async (fromCh: string, toCh: string, profile?: DropProfile) => {
      try {
        setTransitionInProgress(true);

        const context = captureMixContext();
        const suggestion = dropContextAnalyzer.suggestTransitionProfiles(
          context.currentEnergy,
          Math.min(1, context.currentEnergy + 0.3),
          context
        )[0]?.profile;

        const transitionProfile = profile || selectedProfile || suggestion || suggestedProfiles[0];

        if (!transitionProfile) {
          addChatMessage('Kein Transition-Profil verfügbar.', 'ai');
          return;
        }

        await dropEngine.triggerChannelTransition(fromCh, toCh, transitionProfile);
      } catch (err) {
        console.error('Transition failed:', err);
      } finally {
        setTransitionInProgress(false);
      }
    },
    [captureMixContext, selectedProfile, suggestedProfiles, addChatMessage]
  );

  const savePreset = useCallback(async (profile: DropProfile, name: string, tags?: string[]) => {
    try {
      const preset = await dropPresetStore.savePreset(profile, name, tags);
      setPresets((prev) => [...prev, preset]);
      addChatMessage(`Saved preset: "${name}"`, 'ai');
    } catch (err) {
      console.error('Save failed:', err);
    }
  }, [addChatMessage]);

  const loadPreset = useCallback(async (id: string) => {
    try {
      const preset = await dropPresetStore.loadPreset(id);
      if (preset) {
        setSelectedProfile(preset.profile);
        await dropPresetStore.recordUsage(id);
      }
    } catch (err) {
      console.error('Load failed:', err);
    }
  }, []);

  const toggleFavorite = useCallback(async (presetId: string) => {
    try {
      await dropPresetStore.toggleFavorite(presetId);
      const favs = await dropPresetStore.getFavorites();
      setFavorites(favs);
    } catch (err) {
      console.error('Favorite toggle failed:', err);
    }
  }, []);

  const clearChat = useCallback(() => {
    setChatHistory([]);
  }, []);

  const setSelectedChannels = useCallback((start?: string, end?: string) => {
    setSelectedStartChannel(start);
    setSelectedEndChannel(end);
  }, []);

  const value: DropContextType = {
    mode,
    selectedProfile,
    suggestedProfiles,
    aiSuggestions,
    isExecuting,
    executionProgress,
    chatHistory,
    selectedStartChannel,
    selectedEndChannel,
    transitionInProgress,
    presets,
    favorites,
    audioDrops,
    audioDropBusy,
    audioDropStatus,
    quantization,
    padParameters,
    loopState,
    setMode,
    selectProfile,
    generateDrop,
    generateAudioDrop,
    executeDrop,
    triggerDjTransition,
    savePreset,
    loadPreset,
    toggleFavorite,
    addChatMessage,
    clearChat,
    setSelectedChannels,
    setPadParameter,
    setQuantization,
    setLoopLevel,
    setLoopEnabled,
  };

  return <DropContext.Provider value={value}>{children}</DropContext.Provider>;
};

export const useDropContext = (): DropContextType => {
  const ctx = useContext(DropContext);
  if (!ctx) {
    throw new Error('useDropContext must be used within DropProvider');
  }
  return ctx;
};
