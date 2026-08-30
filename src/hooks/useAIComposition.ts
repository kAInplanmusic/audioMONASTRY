// src/hooks/useAIComposition.ts
import axios from 'axios';
import { CompositionResponse, ArrangementSchema } from '../types/composition';
import { API_BASE_URL } from '../config/runtime';

export const useAIComposition = () => {
  
  const generateArrangement = async (prompt: string): Promise<CompositionResponse> => {
    const response = await axios.post(`${API_BASE_URL}/ai/compose`, { prompt });
    
    // Validate with Zod
    const validatedData = ArrangementSchema.parse({
        patterns: response.data.patterns,
        synthNotes: response.data.synthNotes,
        bpm: response.data.bpm,
        genre: response.data.genre
    });
    
    return { ...response.data, ...validatedData };
  };

  return { generateArrangement };
};
