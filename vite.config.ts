import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    build: {
      // P2-5 Bundle-Diät: modernes Browser-Target (Chrome/Edge/Firefox/Safari
      // der Plattform-Matrix) statt ES2020-Downleveling. Spart Transpilierungs-
      // Helfer und hält das UI-Budget < 1,5 MB.
      target: 'esnext',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          // #4 Bundle-Splitting: schwere Pfade (Tone, Audio-Kern, AI, React)
          // als eigene Chunks – paralleles Laden + bessere Caches.
          manualChunks(id) {
            if (id.includes('node_modules/tone') || id.includes('node_modules/@tonejs')) return 'tone';
            if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/scheduler')) return 'react';
            if (id.includes('node_modules/lucide')) return 'icons';
            // L-5/T-0014: Schwergewichte aus dem vendor-Chunk herauslösen –
            // jeder dieser Blöcke ist >100 kB und wird nur in bestimmten
            // Flows gebraucht (bessere Cache-Hit-Rate, paralleler Ladevorgang).
            if (id.includes('node_modules/onnxruntime-web') || id.includes('node_modules/onnxruntime-common')) return 'onnx';
            if (id.includes('node_modules/mediasoup-client')) return 'mediasoup';
            if (id.includes('node_modules/@supabase') || id.includes('node_modules/@supabase/postgrest-js')) return 'supabase';
            if (id.includes('node_modules/motion') || id.includes('node_modules/framer-motion')) return 'motion';
            if (id.includes('node_modules/socket.io')) return 'socketio';
            if (id.includes('node_modules')) return 'vendor';
            if (id.includes('/src/utils/audioEngine') || id.includes('/src/core/audio') || id.includes('/src/core/instrument') || id.includes('/src/audio/')) return 'audio-core';
            if (id.includes('/src/core/ai') || id.includes('/src/core/voice')) return 'ai-core';
            return undefined;
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
