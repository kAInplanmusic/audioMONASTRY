//! audioMONASTRY · dsp_kernel – WASM-Äquivalent zu `src/audio/wasm/dspKernel.c`
//! ===========================================================================
//! Einfacher Mix/Gain-Kern (2 Kanäle), Export über C-ABI, damit der bestehende
//! `WasmBackend` (prüft `dsp_process` als Export) unveraendert funktioniert.
//!
//! JS-Nutzung (siehe WasmBackend.ts):
//!   1. WebAssembly.instantiate(module, {})
//!   2. Exporte: dsp_process, alloc, free, memory
//!   3. Input-Buffer per alloc besorgen, Samples schreiben, dsp_process(ptrs…)
//!
//! Keine Allokation im Prozess-Pfad; NaN/Inf wird zu 0.0 geglättet
//! (Identisches Verhalten zur C-Referenz).

/// In-place Gain auf L/R (getrennte Slices, gleiche Länge).
/// NaN/Inf → 0.0 (bit-identisch zur isfinite()-Logik der C-Vorlage).
fn apply_gain(in_buf: &[f32], out_buf: &mut [f32], gain: f32) {
    for (i, s) in in_buf.iter().enumerate() {
        let v = s * gain;
        out_buf[i] = if v.is_finite() { v } else { 0.0 };
    }
}

/// Skaliert 4 Buffer: [in_l_ptr, in_r_ptr, out_l_ptr, out_r_ptr], len, gain.
/// Sicher: caller garantiert, dass alle vier Slices >= len sind (siehe alloc).
#[no_mangle]
pub unsafe extern "C" fn dsp_process(
    in_l: *const f32,
    in_r: *const f32,
    out_l: *mut f32,
    out_r: *mut f32,
    n: i32,
    gain: f32,
) {
    if n <= 0 || in_l.is_null() || in_r.is_null() || out_l.is_null() || out_r.is_null() {
        return;
    }
    let len = n as usize;
    let in_l = std::slice::from_raw_parts(in_l, len);
    let in_r = std::slice::from_raw_parts(in_r, len);
    let out_l = std::slice::from_raw_parts_mut(out_l, len);
    let out_r = std::slice::from_raw_parts_mut(out_r, len);
    apply_gain(in_l, out_l, gain);
    apply_gain(in_r, out_r, gain);
}

/// Reserviert `len * 4` Bytes (aligned auf f32) im WASM-Linear-Heap.
#[no_mangle]
pub unsafe extern "C" fn alloc(len: i32) -> *mut f32 {
    if len <= 0 {
        return std::ptr::null_mut();
    }
    let layout = std::alloc::Layout::from_size_align_unchecked((len as usize) * 4, 4);
    std::alloc::alloc(layout) as *mut f32
}

/// Gibt einen vorher per `alloc` reservierten Block wieder frei.
#[no_mangle]
pub unsafe extern "C" fn free_ptr(ptr: *mut f32, len: i32) {
    if ptr.is_null() || len <= 0 {
        return;
    }
    let layout = std::alloc::Layout::from_size_align_unchecked((len as usize) * 4, 4);
    std::alloc::dealloc(ptr as *mut u8, layout);
}
