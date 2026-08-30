import React, { useState, useEffect, useMemo } from 'react';


import { Search, Filter } from 'lucide-react';
import { useSamples } from '../context/SampleContext';
import { AudioSample } from '../data/samples';
import { isLocalEmbeddingAvailable, generateLocalEmbedding } from '../utils/LocalEmbeddingProvider';

interface SemanticSampleSearchProps {
  onSelect: (sample: AudioSample) => void;
  filterType?: string;
}

export const SemanticSampleSearch: React.FC<SemanticSampleSearchProps> = ({ onSelect, filterType }) => {
  const { samples } = useSamples();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [filteredSamples, setFilteredSamples] = useState<AudioSample[]>([]);
  const itemsPerPage = 10;

  // Debounce query
  useEffect(() => {
    const handler = setTimeout(() => {
        setDebouncedQuery(query);
    }, 300);

    return () => clearTimeout(handler);
  }, [query]);

  useEffect(() => {
    const performSearch = async () => {
        if (!debouncedQuery) {
            setFilteredSamples([]);
            return;
        }
        setIsLoading(true);

        if (await isLocalEmbeddingAvailable()) {
            await generateLocalEmbedding(debouncedQuery);
            // console.log("Local embedding generated for search");
        }

        // Simulate API latency
        await new Promise(resolve => setTimeout(resolve, 300));

        const q = debouncedQuery.toLowerCase();
        const results = samples.filter(s =>
          (s.name.toLowerCase().includes(q) ||
           (s.tags ?? []).some(t => t.toLowerCase().includes(q)) ||
           s.type.toLowerCase().includes(q) ||
           s.id.toLowerCase().includes(q)) &&
          (!filterType || s.type === filterType)
        );
        setFilteredSamples(results);
        setIsLoading(false);
    };
    performSearch();
  }, [debouncedQuery, samples, filterType]);

  const paginatedSamples = useMemo(() => {
    const startIndex = (page - 1) * itemsPerPage;
    return filteredSamples.slice(startIndex, startIndex + itemsPerPage);
  }, [filteredSamples, page]);

  const totalPages = Math.ceil(filteredSamples.length / itemsPerPage);

  // Reset page when query changes
  React.useEffect(() => {
      setPage(1);
  }, [query]);

  return (
    <div className="relative z-50">
      <div className="flex items-center gap-2 bg-[#1a1a1a] border not-focus-within:border-neutral-800 rounded-lg p-2 focus-within:border-fuchsia-500 transition-colors">
        <Search className="w-4 h-4 text-neutral-500" />
        <input
            type="text"
            placeholder="Suche..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="bg-transparent border-none text-[10px] text-white focus:outline-none w-full"
        />
        <Filter className="w-3 h-3 text-neutral-600" />
      </div>

      {query && (
        <div className="absolute top-full mt-2 w-full bg-[#111] border border-neutral-800 rounded-lg shadow-2xl overflow-hidden">
          {isLoading ? (
            <div className="px-4 py-3 text-[10px] text-neutral-500 animate-pulse">Suche...</div>
          ) : filteredSamples.length > 0 ? (
            <>
              {paginatedSamples.map(s => (
                <button type="button"
                  key={s.id}
                  onClick={() => { onSelect(s); setQuery(''); }}
                  className="w-full text-left px-4 py-2 hover:bg-fuchsia-900/20 text-[10px] font-mono text-neutral-300 border-b border-neutral-800 last:border-0"
                >
                  <span className="text-fuchsia-400">[{s.type}]</span> {s.name} <span className="text-neutral-600">({s.id})</span>
                </button>
              ))}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-2 bg-neutral-900 border-t border-neutral-800 text-[9px] text-neutral-500">
                    <button type="button" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Prev</button>
                    <span>Seite {page} / {totalPages}</span>
                    <button type="button" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
                </div>
              )}
            </>
          ) : (
            <div className="px-4 py-3 text-[10px] text-neutral-600 italic">Keine Ergebnisse gefunden...</div>
          )}
        </div>
      )}
    </div>
  );
};
