/**
 * audioMONASTRY · ControlBus (AM-E2-2)
 * =====================================
 * Typisierter Event-Bus als Ersatz für `window.dispatchEvent(new CustomEvent('monk:*'))`.
 * Im Browser wird zusätzlich ein window-Event emittiert (Abwärtskompatibilität),
 * der Audio-Pfad nutzt ausschließlich den typisierten Bus.
 */

type Handler<T> = (payload: T) => void;

export class ControlBus {
  private handlers = new Map<string, Set<Handler<any>>>();

  on<T>(event: string, handler: Handler<T>): () => void {
    let set = this.handlers.get(event);
    if (!set) { set = new Set(); this.handlers.set(event, set); }
    set.add(handler);
    return () => set.delete(handler);
  }

  emit<T>(event: string, payload: T): void {
    const set = this.handlers.get(event);
    if (set) for (const h of set) { try { h(payload); } catch (e) { console.warn('[ControlBus] handler error', event, e); } }
    if (typeof window !== 'undefined') {
      try { window.dispatchEvent(new CustomEvent(event, { detail: payload })); } catch { /* jsdom/worker */ }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

export const controlBus = new ControlBus();
