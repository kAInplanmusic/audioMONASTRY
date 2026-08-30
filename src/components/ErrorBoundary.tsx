import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}

/**
 * DCT-118: White-Screen-Killer – globaler Error Boundary mit Diagnose-
 * Informationen (Fehler + Stack + Komponenten-Stack) und Recovery-Button.
 * Ergänzt wird er durch die Boot-Diagnostics in main.tsx (window.onerror /
 * unhandledrejection → Konsole) und die Modul-Error-Boundaries
 * (SafeModuleBoundary pro Plugin).
 */
export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
  };

  public static getDerivedStateFromError(_: Error): State {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
    this.setState({ error, errorInfo });
  }

  public render() {
    if (this.state.hasError) {
      const { error, errorInfo } = this.state;
      return (
        <div role="alert" className="min-h-screen flex flex-col items-center justify-center bg-red-950/40 text-white p-8 font-mono">
          <h1 className="text-2xl font-bold mb-2">Something went wrong.</h1>
          <p className="text-neutral-400 mb-4 text-sm">Die App konnte nicht geladen werden – Diagnose unten.</p>

          <div className="w-full max-w-2xl bg-black rounded p-4 overflow-auto border border-red-900/60">
            <h2 className="text-red-400 text-xs uppercase tracking-widest mb-1">Fehler</h2>
            <pre className="text-xs whitespace-pre-wrap mb-4">{error?.message ?? 'Unbekannter Fehler'}</pre>

            {error?.stack && (
              <>
                <h2 className="text-red-400 text-xs uppercase tracking-widest mb-1">Stack</h2>
                <pre className="text-xs whitespace-pre-wrap mb-4 max-h-40 overflow-auto">{error.stack}</pre>
              </>
            )}

            {errorInfo?.componentStack && (
              <>
                <h2 className="text-red-400 text-xs uppercase tracking-widest mb-1">Komponenten-Stack</h2>
                <pre className="text-xs whitespace-pre-wrap max-h-40 overflow-auto">{errorInfo.componentStack}</pre>
              </>
            )}
          </div>

          <button
            type="button"
            className="mt-4 px-4 py-2 bg-red-600 rounded hover:bg-red-500"
            onClick={() => window.location.reload()}
          >
            Reload App
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
