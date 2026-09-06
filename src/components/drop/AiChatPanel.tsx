/**
 * dropMONK – AI Chat Panel Component
 * =================================
 * Chat interface for AI-generated drops
 */

import React, { useRef, useEffect, useState } from 'react';
import { Send, Loader } from 'lucide-react';
import { useDropContext } from '../../context/DropContext';

const SUGGESTIONS = ['Energy', 'Ambient', 'Techno', 'Sidechain', 'Breakdown', 'Cymbal'];

export const AiChatPanel: React.FC = () => {
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- bewusst beibehalten (Runde 3)
  const { chatHistory, generateDrop, addChatMessage, selectProfile, aiSuggestions } =
    useDropContext();
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatHistory]);

  const handleSend = async () => {
    if (!input.trim()) return;

    setIsLoading(true);
    try {
      await generateDrop(input);
      setInput('');
    } catch (err) {
      console.error('Chat error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSuggestion = async (suggestion: string) => {
    setIsLoading(true);
    try {
      await generateDrop(suggestion);
    } catch (err) {
      console.error('Suggestion error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Chat History */}
      <div className="h-64 overflow-y-auto bg-neutral-950/50 border border-neutral-800 rounded-lg p-4 space-y-3">
        {chatHistory.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <p className="text-[11px] text-neutral-600 text-center">
              Chat with AI to generate custom drops.
              <br />
              Describe your desired sound!
            </p>
          </div>
        ) : (
          chatHistory.map((msg) => (
            <div key={msg.id} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-xs px-3 py-2 rounded-lg text-[11px] ${
                  msg.sender === 'user'
                    ? 'bg-rose-500/30 text-rose-100 border border-rose-500/30'
                    : 'bg-neutral-800 text-neutral-200 border border-neutral-700'
                }`}
              >
                <p>{msg.text}</p>
                {msg.generatedProfile && msg.confidence && (
                  <p className="text-[9px] text-neutral-400 mt-1">
                    Confidence: {(msg.confidence * 100).toFixed(0)}%
                  </p>
                )}
              </div>
            </div>
          ))
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Suggestion Pills */}
      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            onClick={() => handleSuggestion(suggestion)}
            disabled={isLoading}
            className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded text-[10px] font-mono text-neutral-300 transition-all disabled:opacity-50"
          >
            {suggestion}
          </button>
        ))}
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Describe your drop..."
          disabled={isLoading}
          className="flex-1 bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-[12px] text-neutral-100 placeholder-neutral-600 focus:border-rose-500/50 focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || isLoading}
          className="px-4 py-2 bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/60 rounded text-rose-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isLoading ? <Loader className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </div>

      {/* AI Suggestions Carousel */}
      {aiSuggestions.length > 0 && (
        <div className="bg-neutral-900/50 border border-neutral-800 rounded-lg p-3">
          <p className="text-[9px] font-bold tracking-[0.2em] text-neutral-500 uppercase mb-2">
            AI Suggestions
          </p>
          <div className="space-y-2">
            {aiSuggestions.slice(-3).map((suggestion) => (
              <button
                key={suggestion.id}
                onClick={() => selectProfile(suggestion)}
                className="w-full text-left p-2 bg-neutral-800/50 hover:bg-neutral-800 border border-neutral-700 rounded transition-all"
              >
                <p className="text-[11px] font-bold text-rose-200">{suggestion.name}</p>
                <p className="text-[9px] text-neutral-400">
                  Confidence: {(suggestion.confidence * 100).toFixed(0)}%
                </p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
