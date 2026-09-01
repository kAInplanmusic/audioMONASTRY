//! audioMONASTRY · hrtf_conv – partitioned-FFT-HRTF-Faltung als WASM-Kernel
//! ======================================================================
//! Uniform partitioned convolution (UPOLS) für zwei Ohren:
//!   - Blockgröße B = 128 Samples, FFT-Größe 2B = 256
//!   - HRTF/IR-Länge bis 1024 Samples (8 Partitionen), voralloziert
//!   - keine Allokation nach `hrtf_init`
//!
//! JS-seitige Nutzung (siehe src/audio/spatial/wasmHrtf.ts):
//!   1. WebAssembly.instantiate(module, {})
//!   2. hrtf_init(block, ir_len)
//!   3. Pointer holen: in_l_ptr / in_r_ptr / out_l_ptr / out_r_ptr
//!   4. hrtf_set_ir(irL, irR, len)
//!   5. je Block: Input in IN_L/IN_R schreiben, hrtf_process(block) rufen,
//!      OUT_L/OUT_R auslesen
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::sync::Arc;

const MAX_BLOCK: usize = 128;
const MAX_IR: usize = 1024;

// Statische Puffer – feste Offsets im WASM-Linear-Memory, keine Allokator-Pflicht.
static mut IN_L: [f32; MAX_BLOCK] = [0.0; MAX_BLOCK];
static mut IN_R: [f32; MAX_BLOCK] = [0.0; MAX_BLOCK];
static mut OUT_L: [f32; MAX_BLOCK] = [0.0; MAX_BLOCK];
static mut OUT_R: [f32; MAX_BLOCK] = [0.0; MAX_BLOCK];

struct ConvState {
    block: usize,
    partitions: usize,
    fwd: Arc<dyn Fft<f32>>,
    inv: Arc<dyn Fft<f32>>,
    ir_l: Vec<Vec<Complex<f32>>>,
    ir_r: Vec<Vec<Complex<f32>>>,
    in_l: Vec<Vec<Complex<f32>>>,
    in_r: Vec<Vec<Complex<f32>>>,
    time_buf: Vec<Complex<f32>>,
    acc: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    overlap_l: Vec<f32>,
    overlap_r: Vec<f32>,
    cursor: usize,
}

static mut STATE: Option<ConvState> = None;

fn fft_plan(size: usize, inverse: bool) -> Arc<dyn Fft<f32>> {
    let mut planner = FftPlanner::new();
    if inverse {
        planner.plan_fft_inverse(size)
    } else {
        planner.plan_fft_forward(size)
    }
}

fn fft_in_place(plan: &Arc<dyn Fft<f32>>, buf: &mut [Complex<f32>], scratch: &mut [Complex<f32>]) {
    plan.process_with_scratch(buf, scratch);
}

impl ConvState {
    fn convolve_ear(&mut self, input: &[f32], output: &mut [f32], left: bool) {
        let b = self.block;
        let fft_size = b * 2;

        // Input-Block → Zeitpuffer → FFT
        for i in 0..fft_size {
            let v = if i < b { input[i] } else { 0.0 };
            self.time_buf[i] = Complex::new(v, 0.0);
        }
        fft_in_place(&self.fwd, &mut self.time_buf, &mut self.scratch);

        let bank_in = if left { &mut self.in_l } else { &mut self.in_r };
        bank_in[self.cursor].copy_from_slice(&self.time_buf);

        let bank_ir = if left { &self.ir_l } else { &self.ir_r };

        // Y = Σ X_{n-p} · H_p
        for i in 0..fft_size {
            self.acc[i] = Complex::new(0.0, 0.0);
        }
        for p in 0..self.partitions {
            let idx = (self.cursor + self.partitions - p) % self.partitions;
            for i in 0..fft_size {
                let x = bank_in[idx][i];
                let h = bank_ir[p][i];
                self.acc[i] = self.acc[i] + x * h;
            }
        }

        // IFFT + Overlap-Add
        fft_in_place(&self.inv, &mut self.acc, &mut self.scratch);
        let scale = 1.0 / fft_size as f32;
        let overlap = if left { &mut self.overlap_l } else { &mut self.overlap_r };
        for i in 0..b {
            output[i] = overlap[i] + self.acc[i].re * scale;
            overlap[i] = self.acc[b + i].re * scale;
        }
    }
}

#[no_mangle]
pub extern "C" fn hrtf_init(block: u32, ir_len: u32) -> i32 {
    let b = block as usize;
    let l = ir_len as usize;
    if b != MAX_BLOCK || l == 0 || l > MAX_IR {
        return -1;
    }
    let partitions = l.div_ceil(b);
    let fft_size = b * 2;
    let fwd = fft_plan(fft_size, false);
    let inv = fft_plan(fft_size, true);

    let state = ConvState {
        block: b,
        partitions,
        fwd,
        inv,
        ir_l: vec![vec![Complex::new(0.0, 0.0); fft_size]; partitions],
        ir_r: vec![vec![Complex::new(0.0, 0.0); fft_size]; partitions],
        in_l: vec![vec![Complex::new(0.0, 0.0); fft_size]; partitions],
        in_r: vec![vec![Complex::new(0.0, 0.0); fft_size]; partitions],
        time_buf: vec![Complex::new(0.0, 0.0); fft_size],
        acc: vec![Complex::new(0.0, 0.0); fft_size],
        scratch: vec![Complex::new(0.0, 0.0); fft_size],
        overlap_l: vec![0.0; b],
        overlap_r: vec![0.0; b],
        cursor: 0,
    };
    unsafe {
        STATE = Some(state);
    }
    0
}

fn set_ir_ear(
    ir: *const f32,
    len: usize,
    bank: &mut [Vec<Complex<f32>>],
    fwd: &Arc<dyn Fft<f32>>,
    scratch: &mut [Complex<f32>],
    b: usize,
) {
    let ir_slice = unsafe { std::slice::from_raw_parts(ir, len) };
    let partitions = bank.len();
    let fft_size = b * 2;
    for p in 0..partitions {
        let mut time = vec![Complex::new(0.0, 0.0); fft_size];
        for i in 0..b {
            let idx = p * b + i;
            let v = if idx < len { ir_slice[idx] } else { 0.0 };
            time[i] = Complex::new(v, 0.0);
        }
        fft_in_place(fwd, &mut time, scratch);
        bank[p] = time;
    }
}

#[no_mangle]
pub extern "C" fn hrtf_set_ir(ir_l: *const f32, ir_r: *const f32, len: u32) -> i32 {
    unsafe {
        let Some(state) = STATE.as_mut() else { return -1 };
        if ir_l.is_null() || ir_r.is_null() || len as usize > MAX_IR {
            return -1;
        }
        set_ir_ear(ir_l, len as usize, &mut state.ir_l, &state.fwd, &mut state.scratch, state.block);
        set_ir_ear(ir_r, len as usize, &mut state.ir_r, &state.fwd, &mut state.scratch, state.block);
        state.overlap_l.fill(0.0);
        state.overlap_r.fill(0.0);
        for p in 0..state.partitions {
            state.in_l[p].fill(Complex::new(0.0, 0.0));
            state.in_r[p].fill(Complex::new(0.0, 0.0));
        }
        state.cursor = 0;
    }
    0
}

#[no_mangle]
pub extern "C" fn hrtf_process(block: u32) -> i32 {
    if block as usize != MAX_BLOCK {
        return -1;
    }
    unsafe {
        let Some(state) = STATE.as_mut() else { return -1 };
        let in_l = std::slice::from_raw_parts(IN_L.as_ptr(), state.block);
        let in_r = std::slice::from_raw_parts(IN_R.as_ptr(), state.block);
        let out_l = std::slice::from_raw_parts_mut(OUT_L.as_mut_ptr(), state.block);
        let out_r = std::slice::from_raw_parts_mut(OUT_R.as_mut_ptr(), state.block);
        state.convolve_ear(in_l, out_l, true);
        state.convolve_ear(in_r, out_r, false);
        state.cursor = (state.cursor + 1) % state.partitions;
    }
    0
}

#[no_mangle]
pub extern "C" fn hrtf_reset() {
    unsafe {
        let Some(state) = STATE.as_mut() else { return };
        state.overlap_l.fill(0.0);
        state.overlap_r.fill(0.0);
        for p in 0..state.partitions {
            state.in_l[p].fill(Complex::new(0.0, 0.0));
            state.in_r[p].fill(Complex::new(0.0, 0.0));
        }
        state.cursor = 0;
    }
}

#[no_mangle]
pub extern "C" fn in_l_ptr() -> *mut f32 {
    unsafe { IN_L.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn in_r_ptr() -> *mut f32 {
    unsafe { IN_R.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn out_l_ptr() -> *mut f32 {
    unsafe { OUT_L.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn out_r_ptr() -> *mut f32 {
    unsafe { OUT_R.as_mut_ptr() }
}
