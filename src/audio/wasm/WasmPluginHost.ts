// src/audio/wasm/WasmPluginHost.ts

export interface WasmPluginInstance {
  process: (input: Float32Array, output: Float32Array) => void;
  setParameter: (name: string, value: number) => void;
}

export class WasmPluginHost {
  private instance: WasmPluginInstance | null = null;

  async loadPlugin(wasmUrl: string): Promise<void> {
    const url = wasmUrl.startsWith('http') ? wasmUrl : new URL(wasmUrl, window.location.origin).href;
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    // Emscripten/WASM instantiation
    const module = await WebAssembly.instantiate(buffer, {
        env: { memory: new WebAssembly.Memory({ initial: 256 }) }
    });
    this.instance = module.instance.exports as unknown as WasmPluginInstance;
  }

  processAudio(input: Float32Array, output: Float32Array) {
    if (this.instance) {
      this.instance.process(input, output);
    }
  }

  setParameter(name: string, value: number) {
    if (this.instance) {
      this.instance.setParameter(name, value);
    }
  }

  dispose() {
    this.instance = null;
  }
}
