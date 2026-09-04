// src/hooks/useAIComposition.ts – ohne axios (Bundle-Diät P2-5)
import { CompositionResponse, ArrangementSchema } from '../types/composition';
import { API_BASE_URL } from '../config/runtime';

export const useAIComposition = () => {
  
  const generateArrangement = async (prompt: string): Promise<CompositionResponse> => {
    const response = await fetch(`${API_BASE_URL}/ai/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = (await response.json()) as CompositionResponse;
    
    // Validate (manuelles Schema, kein zod)
    const validatedData = ArrangementSchema.parse({
        patterns: data.patterns,
        synthNotes: data.synthNotes,
        bpm: data.bpm,
        genre: data.genre
    });
    
    return { ...data, ...validatedData };
  };

  return { generateArrangement };
};
