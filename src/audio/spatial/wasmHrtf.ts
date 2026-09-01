/**
 * spatialMONK · WASM-HRTF-Loader + Fallback (WhitePaper Abschnitt 4, „Full/High“)
 * ==============================================================================
 * - `HrtfConvolverWasm`: partitioned-FFT-Faltung über den Rust-Kernel
 *   `public/hrtf/hrtf_conv.wasm` (Block 128, IR ≤ 1024 Samples, 8 Partitionen)
 * - `JsHrtfConvolver`: deterministischer JS-Fallback (direkte FIR mit Ring-Buffer)
 * - `compileHrtfConvWasm`: fetch + compile (Streaming, mit ArrayBuffer-Fallback)
 */

export interface HrtfConvolver {
  readonly blockSize: number;
  setIr(left: Float32Array, right: Float32Array): void;
  processBlock(inputL: Float32Array, inputR: Float32Array, outL: Float32Array, outR: Float32Array): void;
  reset(): void;
}

export async function compileHrtfConvWasm(url: string): Promise<WebAssembly.Module> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HRTF-WASM HTTP ${res.status}`);
  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      return await WebAssembly.compileStreaming(res);
    } catch { /* Streaming-Compile nicht möglich → ArrayBuffer-Fallback */ }
  }
  const bytes = await res.arrayBuffer();
  return WebAssembly.compile(bytes);
}

interface WasmExports {
  memory: WebAssembly.Memory;
  hrtf_init(block: number, irLen: number): number;
  hrtf_set_ir(irL: number, irR: number, len: number): number;
  hrtf_process(block: number): number;
  hrtf_reset(): void;
  in_l_ptr(): number;
  in_r_ptr(): number;
  out_l_ptr(): number;
  out_r_ptr(): number;
}

export class HrtfConvolverWasm implements HrtfConvolver {
  readonly blockSize = 128;
  private exports: WasmExports;
  private irOffset = 0;

  private constructor(exports: WasmExports) {
    this.exports = exports;
  }

  /** Frische Views auf das aktuelle WASM-Memory (memory.grow-sicher). */
  private views() {
    const mem = this.exports.memory.buffer;
    return {
      inL: new Float32Array(mem, this.exports.in_l_ptr(), this.blockSize),
      inR: new Float32Array(mem, this.exports.in_r_ptr(), this.blockSize),
      outL: new Float32Array(mem, this.exports.out_l_ptr(), this.blockSize),
      outR: new Float32Array(mem, this.exports.out_r_ptr(), this.blockSize),
    };
  }

  static async create(moduleOrUrl: WebAssembly.Module | string, irLen = 1024): Promise<HrtfConvolverWasm> {
    const module = typeof moduleOrUrl === 'string' ? await compileHrtfConvWasm(moduleOrUrl) : moduleOrUrl;
    const instance = await WebAssembly.instantiate(module, {});
    const exports = instance.exports as unknown as WasmExports;
    const conv = new HrtfConvolverWasm(exports);
    if (exports.hrtf_init(conv.blockSize, irLen) !== 0) {
      throw new Error('hrtf_init fehlgeschlagen (Block=128, IR≤1024)');
    }
    // IR-Puffer hinter den statischen OUT-Puffern (16-Byte-aligned).
    const mem = exports.memory.buffer;
    const outEnd = exports.out_r_ptr() + conv.blockSize * 4;
    conv.irOffset = (outEnd + 15) & ~15;
    const needed = conv.irOffset + irLen * 2 * 4;
    if (needed > mem.byteLength) {
      const pages = Math.ceil(needed / 65536);
      exports.memory.grow(pages - mem.byteLength / 65536);
    }
    return conv;
  }

  setIr(left: Float32Array, right: Float32Array): void {
    const len = Math.min(1024, left.length, right.length);
    if (len === 0) return;
    const mem = this.exports.memory.buffer;
    const irL = new Float32Array(mem, this.irOffset, len);
    const irR = new Float32Array(mem, this.irOffset + 1024 * 4, len);
    irL.set(left.subarray(0, len));
    irR.set(right.subarray(0, len));
    this.exports.hrtf_set_ir(irL.byteOffset, irR.byteOffset, len);
  }

  processBlock(inputL: Float32Array, inputR: Float32Array, outL: Float32Array, outR: Float32Array): void {
    const v = this.views();
    v.inL.set(inputL.length === this.blockSize ? inputL : inputL.subarray(0, this.blockSize));
    v.inR.set(inputR.length === this.blockSize ? inputR : inputR.subarray(0, this.blockSize));
    this.exports.hrtf_process(this.blockSize);
    outL.set(v.outL);
    outR.set(v.outR);
  }

  reset(): void {
    this.exports.hrtf_reset();
  }
}

export class JsHrtfConvolver implements HrtfConvolver {
  readonly blockSize = 128;
  private irL: Float32Array = new Float32Array(0);
  private irR: Float32Array = new Float32Array(0);
  private histL: Float32Array;
  private histR: Float32Array;
  private histWrite = 0;

  constructor(maxIrLen = 1024) {
    this.histL = new Float32Array(maxIrLen);
    this.histR = new Float32Array(maxIrLen);
  }

  setIr(left: Float32Array, right: Float32Array): void {
    const len = Math.min(this.histL.length, left.length, right.length);
    this.irL = left.slice(0, len);
    this.irR = right.slice(0, len);
    this.histL.fill(0);
    this.histR.fill(0);
    this.histWrite = 0;
  }

  processBlock(inputL: Float32Array, inputR: Float32Array, outL: Float32Array, outR: Float32Array): void {
    const B = this.blockSize;
    const H = this.histL.length;
    const irLen = this.irL.length;
    for (let j = 0; j < B; j++) {
      const xL = inputL[j] ?? 0;
      const xR = inputR[j] ?? 0;
      this.histL[this.histWrite] = xL;
      this.histR[this.histWrite] = xR;
      let accL = 0;
      let accR = 0;
      for (let k = 0; k < irLen; k++) {
        const idx = (this.histWrite - k + H) % H;
        accL += this.histL[idx] * this.irL[k];
        accR += this.histR[idx] * this.irR[k];
      }
      outL[j] = accL;
      outR[j] = accR;
      this.histWrite = (this.histWrite + 1) % H;
    }
  }

  reset(): void {
    this.histL.fill(0);
    this.histR.fill(0);
    this.histWrite = 0;
  }
}
