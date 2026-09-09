import type { PluginState } from '../types';
import type {
  PluginAudioBlock,
  PluginCommand,
  PluginInterface,
  PluginManifest,
  PluginParameterValue,
  PluginRuntimeContext,
  PluginSnapshot,
} from '../plugin_interface';

/**
 * Gemeinsame Basis aller 16 kanonischen Plugin-Adapter.
 *
 * Invarianten:
 * - OFF ist immer ein transparenter Bypass (kein Audioeingriff).
 * - `process()` ist synchron und echtzeit-sicher.
 * - Netzwerk, AI, Storage und React-State sind außerhalb von `process()`.
 * - Locking wird vor mutierenden Aktionen geprüft.
 * - Snapshot/Restore ist deterministisch.
 * - `dispose()` ist idempotent.
 */
export abstract class BasePluginAdapter implements PluginInterface {
  protected context: PluginRuntimeContext | null = null;
  protected parameters: Record<string, number | string | boolean> = {};
  protected disposed = false;

  public state: PluginState = 'OFF';

  protected constructor(
    public readonly manifest: PluginManifest,
  ) {}

  async initialize(context: PluginRuntimeContext): Promise<void> {
    this.assertNotDisposed();
    this.context = context;
    await this.onInitialize(context);
  }

  protected async onInitialize(
    _context: PluginRuntimeContext,
  ): Promise<void> {
    return undefined;
  }

  setState(next: PluginState): void {
    this.assertNotDisposed();
    this.state = next;
  }

  setParameter(parameter: PluginParameterValue): void {
    this.assertNotDisposed();

    if (
      !this.context ||
      this.context.isLockedByOther(this.manifest.id)
    ) {
      return;
    }

    this.parameters[parameter.name] = parameter.value;
    this.onParameter(parameter);
  }

  protected onParameter(_parameter: PluginParameterValue): void {
    return undefined;
  }

  process(block: PluginAudioBlock): PluginAudioBlock {
    this.assertNotDisposed();

    if (this.state === 'OFF') {
      return block;
    }

    return this.onProcess(block);
  }

  protected onProcess(block: PluginAudioBlock): PluginAudioBlock {
    return block;
  }

  async handleCommand(command: PluginCommand): Promise<unknown> {
    this.assertNotDisposed();

    if (this.context?.isLockedByOther(this.manifest.id)) {
      throw new Error(`Plugin ${this.manifest.id} is locked by another user`);
    }

    return this.onCommand(command);
  }

  protected async onCommand(
    command: PluginCommand,
  ): Promise<unknown> {
    throw new Error(
      `Unsupported command ${command.name} for ${this.manifest.id}`,
    );
  }

  snapshot(): PluginSnapshot {
    return {
      pluginId: this.manifest.id,
      state: this.state,
      parameters: { ...this.parameters },
    };
  }

  restore(snapshot: PluginSnapshot): void {
    this.assertNotDisposed();

    if (snapshot.pluginId !== this.manifest.id) {
      throw new Error(
        `Snapshot mismatch: ${snapshot.pluginId} != ${this.manifest.id}`,
      );
    }

    this.state = snapshot.state;
    this.parameters = { ...snapshot.parameters };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    await this.onDispose();
    this.context = null;
  }

  protected async onDispose(): Promise<void> {
    return undefined;
  }

  protected assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`Plugin ${this.manifest.id} is already disposed`);
    }
  }

  /** Kleiner, typisierter Helfer: numerischer Parameter mit Clamp. */
  protected numberParam(
    parameter: PluginParameterValue,
    fallback: number,
    min = -Infinity,
    max = Infinity,
  ): number {
    const raw = typeof parameter.value === 'number' ? parameter.value : Number(parameter.value);
    const n = Number.isFinite(raw) ? raw : fallback;
    return Math.min(max, Math.max(min, n));
  }
}
