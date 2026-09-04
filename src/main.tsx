import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { MasterOutPage } from './pages/MasterOutPage';
import { AudioProvider } from './context/AudioContext';
import { SampleProvider } from './context/SampleContext';
import { ModuleStateProvider } from './context/ModuleStateContext';
import { PluginManagerProvider } from './context/PluginManagerContext';
import { SessionProvider } from './context/SessionContext';
import { AccessProvider } from './context/AccessContext';
import { ProjectProvider } from './context/ProjectContext';

import { ErrorBoundary } from './components/ErrorBoundary';
// Registriert die Standard-Sprach-/KI-Kommandos für die Plugin-Steuerung.
import './core/voice/pluginCommandRegistry';
import { trackError } from './utils/errorTracker';

// DCT-118: Boot-Diagnostics + Auto-Logging – globale Fehler sichtbar machen
// (kein stiller White-Screen) und automatisch an /api/telemetry melden.
window.addEventListener('error', (event) => {
  console.error('[boot] window.onerror:', event.error ?? event.message);
  trackError('window.onerror', event.error ?? event.message, { filename: event.filename, line: event.lineno });
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[boot] unhandledrejection:', event.reason);
  trackError('unhandledrejection', event.reason);
});
// ...

const isMasterOutPage = window.location.pathname.startsWith('/master-out');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {isMasterOutPage ? (
        <MasterOutPage />
      ) : (
        <AccessProvider>
        <SessionProvider>
            <ModuleStateProvider>
            <PluginManagerProvider>
                <ProjectProvider>
                <SampleProvider>
                <AudioProvider>
                    <App />
                </AudioProvider>
                </SampleProvider>
                </ProjectProvider>
            </PluginManagerProvider>
            </ModuleStateProvider>
        </SessionProvider>
        </AccessProvider>
      )}
    </ErrorBoundary>
  </StrictMode>,
);
