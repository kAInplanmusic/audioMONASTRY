/**
 * dropMONK – React Context & State Management
 * ===========================================
 * Zentrale State für Drop-UI
 */

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { DropProfile, GeneratedDropProfile, DropPreset } from '../core/drop';
import { dropPresetStore, dropContextAnalyzer, dropEngine, aiDropGenerator } from '../core/drop';

export type DropMode = 'generator' | 'dj_transition' | 'sampler_top';

export interface ChatMessage {
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

  // Actions
  setMode: (mode: DropMode) => void;
  selectProfile: (profile: DropProfile) => void;
  generateDrop: (prompt: string) => Promise<void>;
  executeDrop: (profile: DropProfile, quantized?: boolean) => Promise<void>;
  triggerDjTransition: (fromCh: string, toCh: string, profile?: DropProfile) => Promise<void>;
  savePreset: (profile: DropProfile, name: string, tags?: string[]) => Promise<void>;
  loadPreset: (id: string) => Promise<void>;
  toggleFavorite: (presetId: string) => Promise<void>;
  addChatMessage: (text: string, sender: 'user' | 'ai', profile?: GeneratedDropProfile) => void;
  clearChat: () => void;
  setSelectedChannels: (start?: string, end?: string) => void;
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

  // Initialize
  useEffect(() => {
    const init = async () => {
      await dropPresetStore.initialize();
      const allPresets = await dropPresetStore.listPresets();
      const favs = await dropPresetStore.getFavorites();
      setPresets(allPresets);
      setFavorites(favs);
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
  }, []);

  const selectProfile = useCallback((profile: DropProfile) => {
    setSelectedProfile(profile);
  }, []);

  const generateDrop = useCallback(async (prompt: string) => {
    try {
      // TODO: Nutze aktuelle Audio Context vom audioEngine
      const context = {
        bpm: 128,
        activePlugins: ['synthesizer', 'effect', 'drum'],
        mixerChannels: [],
        currentEnergy: 0.6,
        timeSignature: '4/4',
        analysisTimestamp: Date.now(),
      };

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
  }, []);

  const executeDrop = useCallback(async (profile: DropProfile, quantized = false) => {
    try {
      await dropEngine.triggerDrop(
        profile,
        quantized ? 'quantized' : 'immediate',
        quantized ? '4bar' : undefined
      );

      // Registriere Usage
      if ('id' in profile && profile.id.startsWith('preset_')) {
        await dropPresetStore.recordUsage(profile.id);
      }
    } catch (err) {
      console.error('Drop execution failed:', err);
    }
  }, []);

  const triggerDjTransition = useCallback(
    async (fromCh: string, toCh: string, profile?: DropProfile) => {
      try {
        setTransitionInProgress(true);

        const transitionProfile =
          profile ||
          selectedProfile ||
          suggestedProfiles[0] ||
          (await dropContextAnalyzer.analyzeCurrentMix(
            128,
            ['mixer'],
            [],
            0.5,
            undefined,
            '4/4'
          ),
          { id: 'dj_transition', name: 'DJ Transition' } as any);

        await dropEngine.triggerChannelTransition(fromCh, toCh, transitionProfile);
      } catch (err) {
        console.error('Transition failed:', err);
      } finally {
        setTransitionInProgress(false);
      }
    },
    [selectedProfile, suggestedProfiles]
  );

  const savePreset = useCallback(async (profile: DropProfile, name: string, tags?: string[]) => {
    try {
      const preset = await dropPresetStore.savePreset(profile, name, tags);
      setPresets((prev) => [...prev, preset]);
      addChatMessage(`Saved preset: "${name}"`, 'ai');
    } catch (err) {
      console.error('Save failed:', err);
    }
  }, []);

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
    setMode,
    selectProfile,
    generateDrop,
    executeDrop,
    triggerDjTransition,
    savePreset,
    loadPreset,
    toggleFavorite,
    addChatMessage,
    clearChat,
    setSelectedChannels,
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
