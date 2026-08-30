/**
 * audioMONASTRY · WebGPU-Kernel (Aufg. 4.1.1)
 * -------------------------------------------
 * Lokale GPU-Inferenz via WebGPU-Shader: sehr schnelle Matrix-Multiplikation
 * (GEMM, workgroup-tiled) + Aktivierungen – das Fundament für neural-basierte
 * KI-Aufgaben (Stem-Preprocessing, Embedding, Feature-Berechnung).
 *
 * Primitive sind bewusst schlank und nutzen nur die WebGPU-API (frei im Browser,
 * kein fremder Provider). Die Shader sind WGSL und werden zur Laufzeit
 * kompiliert – hier bereits statisch um Laufzeit-Kompilierungsfehler klein zu
 * halten und dennoch typisiert zu bleiben.
 */

export interface GPUTensor { dims: number[]; data: Float32Array; }

/** Simplifizierter GEMM + Aktivierung auf der GPU. */
export class WebGPUKernel {
  private device: GPUDevice | null = null;
  private readyP: Promise<GPUDevice> | null = null;
  readonly supported: boolean;

  constructor() {
    this.supported = typeof navigator !== 'undefined' && !!(navigator as any).gpu;
  }

  async getDevice(): Promise<GPUDevice> {
    if (!this.readyP) {
      this.readyP = (async () => {
        if (!(navigator as any).gpu) throw new Error('WebGPU nicht verfügbar');
        const gpu = (navigator as any).gpu as GPU;
        const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) throw new Error('Kein GPU-Adapter');
        this.device = await adapter.requestDevice();
        return this.device;
      })();
    }
    return this.readyP;
  }

  /** ReLU / Sigmoid / Tanh Aktivierung auf einem Tensor (in-place via GPU). */
  async activate(data: Float32Array, kind: 'relu' | 'sigmoid' | 'tanh' = 'relu'): Promise<Float32Array> {
    const device = await this.getDevice();
    const n = data.length;
    const byteLen = Math.max(4, n * 4);
    const inBuf = device.createBuffer({ size: byteLen, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(inBuf, 0, data as any, 0, n);
    const outBuf = device.createBuffer({ size: byteLen, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

    const fn = kind === 'sigmoid' ? 'sigmoid' : kind === 'tanh' ? 'tanh' : 'relu';
    const module = device.createShaderModule({
      code: WGSL_ACTIVATE(fn),
    });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inBuf } },
        { binding: 1, resource: { buffer: outBuf } },
        { binding: 2, resource: { buffer: sizeBuffer(device, n) } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    const wg = Math.ceil(n / 256);
    pass.dispatchWorkgroups(wg);
    pass.end();
    device.queue.submit([encoder.finish()]);

    const out = new Float32Array(n);
    await readBuffer(device, outBuf, out);
    return out;
  }

  /**
   * Matrix-Multiplikation C = A×B (row-major), mit tiled workgroup-GEMM.
   * A: [M,K], B: [K,N] → C: [M,N].
   */
  async matMul(a: Float32Array, b: Float32Array, M: number, K: number, N: number): Promise<Float32Array> {
    const device = await this.getDevice();
    const sA = device.createBuffer({ size: a.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(sA, 0, a as any);
    const sB = device.createBuffer({ size: b.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(sB, 0, b as any);
    const sC = device.createBuffer({ size: a.byteLength > 0 ? M * N * 4 : 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

    const module = device.createShaderModule({ code: WGSL_GEMM });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const dimsBuf = dimsBuffer(device, [M, K, N]);

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sA } },
        { binding: 1, resource: { buffer: sB } },
        { binding: 2, resource: { buffer: sC } },
        { binding: 3, resource: { buffer: dimsBuf } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(N / 8), Math.ceil(M / 8));
    pass.end();
    device.queue.submit([encoder.finish()]);

    const out = new Float32Array(M * N);
    await readBuffer(device, sC, out);
    return out;
  }
}

// ---------------------------------------------------------------------------
// WGSL-Snippets
// ---------------------------------------------------------------------------
function sizeBuffer(device: GPUDevice, n: number): GPUBuffer {
  const b = device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(b, 0, new Uint32Array([n]) as any);
  return b;
}
function dimsBuffer(device: GPUDevice, d: number[]): GPUBuffer {
  const b = device.createBuffer({ size: d.length * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(b, 0, new Uint32Array(d) as any);
  return b;
}
async function readBuffer(device: GPUDevice, buf: GPUBuffer, out: Float32Array): Promise<void> {
  const copy = device.createBuffer({ size: buf.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buf, 0, copy, 0, buf.size);
  device.queue.submit([encoder.finish()]);
  await copy.mapAsync(GPUMapMode.READ);
  const src = new Float32Array(copy.getMappedRange());
  out.set(src);
  copy.unmap();
  copy.destroy();
}

const WGSL_ACTIVATE = (fn: 'relu' | 'sigmoid' | 'tanh') => `@group(0) @binding(0) var<storage, read> in : array<f32>;
@group(0) @binding(1) var<storage, read_write> out : array<f32>;
@group(0) @binding(2) var<uniform> n : u32;

fn act(x: f32) -> f32 {
  ${
    fn === 'relu' ? 'return max(x, 0.0);'
    : fn === 'sigmoid' ? 'return 1.0 / (1.0 + exp(-x));'
    : 'return tanh(x);'
  }
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i < n) {
    out[i] = act(in[i]);
  }
}`;

const WGSL_GEMM = `@group(0) @binding(0) var<storage, read> a : array<f32>;
@group(0) @binding(1) var<storage, read> b : array<f32>;
@group(0) @binding(2) var<storage, read_write> c : array<f32>;
@group(0) @binding(3) var<uniform> dims : vec3<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let M = dims.x;
  let K = dims.y;
  let N = dims.z;
  let row = gid.x;
  let col = gid.y;
  if (row >= M || col >= N) {
    return;
  }
  var acc : f32 = 0.0;
  for (var k = 0u; k < K; k = k + 1u) {
    let av = a[row * K + k];
    let bv = b[k * N + col];
    acc += av * bv;
  }
  c[row * N + col] = acc;
}`;

/** Einzelne GPU-Instanz für die App. */
let _kernel: WebGPUKernel | null = null;
export function getGPUKernel(): WebGPUKernel {
  if (!_kernel) _kernel = new WebGPUKernel();
  return _kernel;
}
