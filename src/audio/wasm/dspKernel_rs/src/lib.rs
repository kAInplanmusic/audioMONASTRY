//! audioMONASTRY · dsp_kernel – WASM-Äquivalent zu `src/audio/wasm/dspKernel.c`
//! ===========================================================================
//! Kanalzug-Kern (2 Kanäle) mit vier Stufen:
//!   * `dsp_process`      – Gain/Mix (bit-identisch zur C-Vorlage, `WasmBackend`
//!                          prüft genau diesen Export und bleibt unverändert)
//!   * `dsp_filter_*`     – Biquad (TP/HP/BP, RBJ-Cookbook, Cutoff + Q)
//!   * `dsp_saturate_*`   – tanh-Sättigung mit Drive + Output-Trim
//!   * `dsp_comp_*`       – stereo-verkoppelter Kompressor
//!                          (Threshold/Ratio/Attack/Release)
//!
//! Export über C-ABI (kein wasm-bindgen), damit der bestehende Ladepfad
//! (`fetch('/wasm/dspKernel.wasm')` → `WebAssembly.instantiate(mod, {})`) ohne
//! Import-Objekt funktioniert und der TS-Wrapper (`dspKernelWasm.ts`) nur
//! Zahlen übergeben muss.
//!
//! ## Zustand
//! Jede Stufe hält ihren Zustand pro Kanal in einem `static`-Slot, der über
//! `UnsafeCell` mutiert wird (`STATE`). Kein `static mut` → kein
//! `static_mut_refs`-Lint, keine `&mut`-Aliasing-Falle. Der Prozess-Pfad
//! allokiert NICHTS: keine Vec, kein Box, keine Closure-Allokation (die
//! Rechen-Closures sind `FnMut` ohne Capture-Allokation und werden monomorph
//! inlined).
//!
//! ## Genauigkeit
//! Alle Rechenpfade sind `f32` (WASM hat kein f64-SIMD; f32 ist das, was die
//! Web-Audio-Kette ohnehin führt). NaN/Inf wird zu 0.0 geglättet – wie in der
//! C-Vorlage, damit ein kaputter Block die Kette nicht dauerhaft vergiftet.
//!
//! ## Bauen (fehlt in dieser Umgebung)
//! ```text
//! rustup target add wasm32-unknown-unknown          # <- fehlt hier
//! cd src/audio/wasm/dspKernel_rs
//! cargo build --release --target wasm32-unknown-unknown
//! cp target/wasm32-unknown-unknown/release/dsp_kernel.wasm ../../../../public/wasm/dspKernel.wasm
//! ```
//! `cargo test` läuft auch ohne das wasm32-Target (Host-Target, echte
//! Ausführung der Algorithmen).

use core::cell::UnsafeCell;

// ---------------------------------------------------------------------------
// Konstanten / Grenzen
// ---------------------------------------------------------------------------

/// Filtertypen, wie sie über die C-ABI als `i32` übergeben werden.
pub const FILTER_LOWPASS: i32 = 0;
pub const FILTER_HIGHPASS: i32 = 1;
pub const FILTER_BANDPASS: i32 = 2;

/// ABI-Version. Der TS-Wrapper erkennt über die Exportnamen, ob ein
/// ausgeliefertes `.wasm` die Prozessoren enthält; die Version dient der
/// Diagnose im Metrik-/Debug-Pfad.
pub const ABI_VERSION: i32 = 2;

const MIN_CUTOFF_HZ: f32 = 10.0;
const MIN_Q: f32 = 0.1;
const MAX_Q: f32 = 40.0;
const MIN_DRIVE: f32 = 1.0e-3;
const MAX_DRIVE: f32 = 100.0;
const MAX_TRIM: f32 = 4.0;
const MIN_TIME_S: f32 = 1.0e-4;
const MAX_TIME_S: f32 = 2.0;
const MIN_RATIO: f32 = 1.0;
const MAX_RATIO: f32 = 20.0;
const MIN_THRESHOLD_DB: f32 = -96.0;

/// Unter diesem Pegel gilt ein Signal als still (`lin_to_db` → -200 dB).
const SILENCE_LIN: f32 = 1.0e-9;

// ---------------------------------------------------------------------------
// Kleine Helfer
// ---------------------------------------------------------------------------

#[inline]
fn finite_or_zero(v: f32) -> f32 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

#[inline]
fn sanitize(x: f32) -> f32 {
    if x.is_finite() {
        x
    } else {
        0.0
    }
}

#[inline]
fn clamp_or(v: f32, lo: f32, hi: f32, fallback: f32) -> f32 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        fallback
    }
}

#[inline]
fn lin_to_db(lin: f32) -> f32 {
    if lin <= SILENCE_LIN {
        -200.0
    } else {
        20.0 * lin.log10()
    }
}

#[inline]
fn db_to_lin(db: f32) -> f32 {
    if db <= -200.0 {
        0.0
    } else {
        10.0_f32.powf(db * 0.05)
    }
}

/// Ein-Pol-Koeffizient für eine Zeitkonstante in Sekunden.
/// Sprungantwort: `y[n] = ziel + (y[n-1] - ziel) * k`, d.h. nach genau
/// `time_s` Sekunden sind 1 - 1/e = 63,2 % des Ziels erreicht.
#[inline]
fn one_pole_coeff(time_s: f32, sample_rate: f32) -> f32 {
    let t = clamp_or(time_s, MIN_TIME_S, MAX_TIME_S, MIN_TIME_S);
    let sr = if sample_rate.is_finite() && sample_rate > 0.0 {
        sample_rate
    } else {
        48_000.0
    };
    // exp(-1/(tau*fs)); NaN/Inf kann hier nicht entstehen (tau, fs > 0).
    (-1.0 / (t * sr)).exp()
}

// ---------------------------------------------------------------------------
// Biquad
// ---------------------------------------------------------------------------

/// Normalisierte Biquad-Koeffizienten (a0 = 1), RBJ-Audio-EQ-Cookbook.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BiquadCoeffs {
    pub b0: f32,
    pub b1: f32,
    pub b2: f32,
    pub a1: f32,
    pub a2: f32,
}

impl BiquadCoeffs {
    /// Durchreiche-Koeffizienten (y = x).
    pub const fn bypass() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
        }
    }

    /// Entwirft die Koeffizienten für `kind` bei `sample_rate` / `cutoff_hz` / `q`.
    ///
    /// Grenzen werden geklemmt statt zu verwerfen: Cutoff auf
    /// [10 Hz, 0.99 * Nyquist], Q auf [0.1, 40]. Ungültige Argumente (NaN, fs<=0)
    /// ergeben einen Bypass, damit ein Fehler in der Steuerung nicht die Kette
    /// verstummen lässt.
    pub fn design(kind: i32, sample_rate: f32, cutoff_hz: f32, q: f32) -> Self {
        if !sample_rate.is_finite() || sample_rate <= 0.0 {
            return Self::bypass();
        }
        let sr = sample_rate;
        let nyquist = 0.5 * sr;
        // max_f zuerst, dann min_f daraus ableiten: `clamp` panickt bei min > max.
        let max_f = (nyquist * 0.99).max(1.0);
        let min_f = MIN_CUTOFF_HZ.min(max_f * 0.5);
        let f0 = clamp_or(cutoff_hz, min_f, max_f, min_f);
        let qq = clamp_or(q, MIN_Q, MAX_Q, core::f32::consts::FRAC_1_SQRT_2);

        let w0 = 2.0 * core::f32::consts::PI * f0 / sr;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * qq);

        let (b0, b1, b2) = match kind {
            FILTER_HIGHPASS => {
                let g = (1.0 + cos_w0) * 0.5;
                (g, -(1.0 + cos_w0), g)
            }
            // Bandpass mit 0 dB Spitzenverstärkung (konstante 0-dB-Peak-Gain-Form).
            FILTER_BANDPASS => (alpha, 0.0, -alpha),
            // Alles Unbekannte fällt auf Lowpass zurück.
            _ => {
                let g = (1.0 - cos_w0) * 0.5;
                (g, 1.0 - cos_w0, g)
            }
        };

        let a0 = 1.0 + alpha;
        let inv_a0 = 1.0 / a0;
        Self {
            b0: b0 * inv_a0,
            b1: b1 * inv_a0,
            b2: b2 * inv_a0,
            a1: -2.0 * cos_w0 * inv_a0,
            a2: (1.0 - alpha) * inv_a0,
        }
    }

    #[inline]
    fn is_bypass(&self) -> bool {
        self.a1 == 0.0 && self.a2 == 0.0 && self.b1 == 0.0 && self.b2 == 0.0
    }
}

/// Filterzustand eines Kanals (Transposed Direct Form II).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BiquadState {
    z1: f32,
    z2: f32,
}

impl BiquadState {
    pub const fn new() -> Self {
        Self { z1: 0.0, z2: 0.0 }
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }

    #[inline]
    pub fn process(&mut self, c: &BiquadCoeffs, x: f32) -> f32 {
        let x = sanitize(x);
        if c.is_bypass() {
            return x;
        }
        // TDF-II: numerisch günstig, ein Zustandspaar, keine delay-line-Kopie.
        let y = c.b0 * x + self.z1;
        let z1 = c.b1 * x - c.a1 * y + self.z2;
        let z2 = c.b2 * x - c.a2 * y;
        if !y.is_finite() || !z1.is_finite() || !z2.is_finite() {
            // Ein entarteter Block darf den Zustand nicht dauerhaft vergiften.
            self.reset();
            return 0.0;
        }
        self.z1 = z1;
        self.z2 = z2;
        y
    }
}

/// Biquad für beide Kanäle (unabhängiger Zustand je Kanal, gleiche Koeffizienten).
#[derive(Clone, Copy, Debug)]
pub struct StereoBiquad {
    pub coeffs: BiquadCoeffs,
    left: BiquadState,
    right: BiquadState,
}

impl StereoBiquad {
    pub const fn bypass() -> Self {
        Self {
            coeffs: BiquadCoeffs::bypass(),
            left: BiquadState::new(),
            right: BiquadState::new(),
        }
    }

    /// Setzt neue Koeffizienten. Der Filterzustand bleibt erhalten: ein
    /// Parameterwechsel im laufenden Betrieb soll nicht knacken. Ein
    /// Typwechsel (z.B. TP → HP) klingt dadurch kurz nach; wer sauber
    /// umschalten will, ruft vorher `reset()`.
    pub fn set(&mut self, kind: i32, sample_rate: f32, cutoff_hz: f32, q: f32) {
        self.coeffs = BiquadCoeffs::design(kind, sample_rate, cutoff_hz, q);
    }

    pub fn reset(&mut self) {
        self.left.reset();
        self.right.reset();
    }

    #[inline]
    pub fn process_sample(&mut self, l: f32, r: f32) -> (f32, f32) {
        (
            self.left.process(&self.coeffs, l),
            self.right.process(&self.coeffs, r),
        )
    }
}

// ---------------------------------------------------------------------------
// Sättigung
// ---------------------------------------------------------------------------

/// tanh-Sättigung: `y = tanh(x * drive) * trim`.
///
/// Eigenschaften, auf die sich die Tests stützen:
/// * monoton steigend in x für drive > 0 (tanh ist monoton),
/// * beschränkt: |y| <= |trim| für jedes endliche x,
/// * Kleinsignalverstärkung an der Nullstelle = drive * trim.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Saturation {
    drive: f32,
    trim: f32,
}

impl Saturation {
    /// Neutral: drive 1, trim 1 → praktisch linear für |x| << 1.
    pub const fn unity() -> Self {
        Self {
            drive: 1.0,
            trim: 1.0,
        }
    }

    pub fn new(drive: f32, trim: f32) -> Self {
        Self {
            drive: clamp_or(drive, MIN_DRIVE, MAX_DRIVE, 1.0),
            trim: clamp_or(trim, -MAX_TRIM, MAX_TRIM, 1.0),
        }
    }

    pub fn set(&mut self, drive: f32, trim: f32) {
        *self = Self::new(drive, trim);
    }

    pub fn drive(&self) -> f32 {
        self.drive
    }

    pub fn trim(&self) -> f32 {
        self.trim
    }

    #[inline]
    pub fn process_sample(&self, x: f32) -> f32 {
        finite_or_zero((sanitize(x) * self.drive).tanh() * self.trim)
    }
}

// ---------------------------------------------------------------------------
// Kompressor
// ---------------------------------------------------------------------------

/// Feed-Forward-Peak-Kompressor, stereo-verkoppelt.
///
/// Detektor: `max(|L|, |R|)` – beide Kanäle bekommen identisch Gain, das
/// Stereobild bleibt also erhalten (kein Pumpen einzelner Seiten).
/// Kennlinie: `GR_dB = (T - L_dB) * (1 - 1/ratio)` für `L_dB > T`, sonst 0.
/// Glättung: Ein-Pol im dB-Bereich, Attack beim Zunehmen der Reduktion,
/// Release beim Abnehmen. Definition der Zeitkonstanten: nach genau
/// `attack`/`release` Sekunden sind 63,2 % (1 - 1/e) des Ziels erreicht.
///
/// Bekannte Grenze: der Detektor ist momentanwertbasiert (kein Peak-Hold),
/// deshalb moduliert tieffrequenter Inhalt den Gain (klassisches
/// Feed-Forward-Verhalten). Ein Peak-Hold-Detektor wäre die nächste Stufe.
#[derive(Clone, Copy, Debug)]
pub struct Compressor {
    threshold_db: f32,
    ratio: f32,
    /// `1 - 1/ratio`, pro Sample-Rate einmal vorberechnet.
    slope: f32,
    attack_coeff: f32,
    release_coeff: f32,
    /// Geglättete Gain-Reduktion in dB (<= 0).
    gain_db: f32,
}

impl Compressor {
    /// Aus (ratio 1:1 → keine Regelung).
    pub const fn disabled() -> Self {
        Self {
            threshold_db: 0.0,
            ratio: 1.0,
            slope: 0.0,
            attack_coeff: 1.0,
            release_coeff: 1.0,
            gain_db: 0.0,
        }
    }

    pub fn new(
        sample_rate: f32,
        threshold_db: f32,
        ratio: f32,
        attack_s: f32,
        release_s: f32,
    ) -> Self {
        let mut c = Self::disabled();
        c.set(sample_rate, threshold_db, ratio, attack_s, release_s);
        c
    }

    pub fn set(
        &mut self,
        sample_rate: f32,
        threshold_db: f32,
        ratio: f32,
        attack_s: f32,
        release_s: f32,
    ) {
        if !sample_rate.is_finite() || sample_rate <= 0.0 {
            *self = Self::disabled();
            return;
        }
        self.threshold_db = clamp_or(threshold_db, MIN_THRESHOLD_DB, 0.0, -20.0);
        self.ratio = clamp_or(ratio, MIN_RATIO, MAX_RATIO, 1.0);
        self.slope = 1.0 - 1.0 / self.ratio;
        self.attack_coeff = one_pole_coeff(attack_s, sample_rate);
        self.release_coeff = one_pole_coeff(release_s, sample_rate);
    }

    pub fn reset(&mut self) {
        self.gain_db = 0.0;
    }

    /// Aktuelle Gain-Reduktion in dB (Metering). 0 = unbeeinflusst.
    pub fn gain_db(&self) -> f32 {
        self.gain_db
    }

    pub fn threshold_db(&self) -> f32 {
        self.threshold_db
    }

    pub fn ratio(&self) -> f32 {
        self.ratio
    }

    #[inline]
    pub fn process_sample(&mut self, l: f32, r: f32) -> (f32, f32) {
        let l = sanitize(l);
        let r = sanitize(r);

        // Stereo-Link: der lautere Kanal bestimmt die Regelung für beide.
        let level = l.abs().max(r.abs());
        let over = lin_to_db(level) - self.threshold_db;
        let target_db = if over > 0.0 { -over * self.slope } else { 0.0 };

        let coeff = if target_db < self.gain_db {
            self.attack_coeff
        } else {
            self.release_coeff
        };
        let next = target_db + (self.gain_db - target_db) * coeff;
        self.gain_db = if next.is_finite() {
            next.clamp(-96.0, 0.0)
        } else {
            0.0
        };

        let g = db_to_lin(self.gain_db);
        (
            finite_or_zero(l * g),
            finite_or_zero(r * g),
        )
    }
}

// ---------------------------------------------------------------------------
// Globaler Zustand (C-ABI-Schicht)
// ---------------------------------------------------------------------------

/// Ein Satz Prozessoren, wie ihn ein Kanalzug braucht.
struct Kernel {
    filter: StereoBiquad,
    sat: Saturation,
    comp: Compressor,
}

impl Kernel {
    const fn bare() -> Self {
        Self {
            filter: StereoBiquad::bypass(),
            sat: Saturation::unity(),
            comp: Compressor::disabled(),
        }
    }
}

/// `UnsafeCell` statt `static mut`: der Zugriff läuft über `STATE.0.get()`,
/// damit kein `&mut static` entsteht (Lint + Aliasing-Regel). WASM ist
/// single-threaded; die C-ABI-Verträge verlangen ohnehin, dass ein Modul pro
/// Audio-Thread instanziiert wird.
struct KernelSlot(UnsafeCell<Kernel>);
unsafe impl Sync for KernelSlot {}

static STATE: KernelSlot = KernelSlot(UnsafeCell::new(Kernel::bare()));

#[inline]
fn state() -> &'static mut Kernel {
    // SAFETY: WASM-Instanzen sind single-threaded; alle Exporte werden aus
    // genau einem Audio-Thread aufgerufen und greifen nie verschachtelt zu
    // (kein Export ruft einen anderen Export auf).
    unsafe { &mut *STATE.0.get() }
}

// ---------------------------------------------------------------------------
// Bestehender Gain/Mix-Export (unverändert gegenüber dem C-Kern)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// C-ABI: Prozessor-Steuerung
// ---------------------------------------------------------------------------

/// ABI-Version des geladenen Moduls.
#[no_mangle]
pub extern "C" fn dsp_abi_version() -> i32 {
    ABI_VERSION
}

/// Filterparameter setzen (Koeffizienten werden hier, nicht im Sample-Loop
/// berechnet – der Prozess-Pfad enthält kein `sin`/`cos`).
///
/// `kind`: 0 = Lowpass, 1 = Highpass, 2 = Bandpass.
#[no_mangle]
pub extern "C" fn dsp_filter_set(kind: i32, sample_rate: f32, cutoff_hz: f32, q: f32) {
    state().filter.set(kind, sample_rate, cutoff_hz, q);
}

/// Filterzustand (beide Kanäle) zurücksetzen.
#[no_mangle]
pub extern "C" fn dsp_filter_reset() {
    state().filter.reset();
}

/// Filter über einen Block. Liest `in_l/in_r[i]`, schreibt `out_l/out_r[i]`.
/// In-place erlaubt (Index i wird gelesen, bevor er geschrieben wird).
#[no_mangle]
pub unsafe extern "C" fn dsp_filter_process(
    in_l: *const f32,
    in_r: *const f32,
    out_l: *mut f32,
    out_r: *mut f32,
    n: i32,
) {
    let filter = &mut state().filter;
    process_stereo(in_l, in_r, out_l, out_r, n, |l, r| {
        filter.process_sample(l, r)
    });
}

/// Sättigungsparameter setzen: `drive` > 0, `trim` = Ausgangstrim (linear).
#[no_mangle]
pub extern "C" fn dsp_saturate_set(drive: f32, trim: f32) {
    state().sat.set(drive, trim);
}

/// tanh-Sättigung über einen Block (zustandslos, kein Reset nötig).
#[no_mangle]
pub unsafe extern "C" fn dsp_saturate_process(
    in_l: *const f32,
    in_r: *const f32,
    out_l: *mut f32,
    out_r: *mut f32,
    n: i32,
) {
    let sat = state().sat;
    process_stereo(in_l, in_r, out_l, out_r, n, |l, r| {
        (sat.process_sample(l), sat.process_sample(r))
    });
}

/// Kompressorparameter setzen. Zeiten in Sekunden (63,2-%-Definition).
#[no_mangle]
pub extern "C" fn dsp_comp_set(
    sample_rate: f32,
    threshold_db: f32,
    ratio: f32,
    attack_s: f32,
    release_s: f32,
) {
    state()
        .comp
        .set(sample_rate, threshold_db, ratio, attack_s, release_s);
}

/// Kompressor-Hüllkurve zurücksetzen (Gain-Reduktion auf 0 dB).
#[no_mangle]
pub extern "C" fn dsp_comp_reset() {
    state().comp.reset();
}

/// Aktuelle Gain-Reduktion in dB (für Metering und Tests).
#[no_mangle]
pub extern "C" fn dsp_comp_gain_db() -> f32 {
    state().comp.gain_db()
}

/// Stereo-verkoppelter Kompressor über einen Block.
#[no_mangle]
pub unsafe extern "C" fn dsp_comp_process(
    in_l: *const f32,
    in_r: *const f32,
    out_l: *mut f32,
    out_r: *mut f32,
    n: i32,
) {
    let comp = &mut state().comp;
    process_stereo(in_l, in_r, out_l, out_r, n, |l, r| {
        comp.process_sample(l, r)
    });
}

/// Gemeinsamer Block-Loop. `f` wird pro Sample aufgerufen und darf den
/// Prozessor-Zustand mutieren; es allokiert nichts.
#[inline]
unsafe fn process_stereo<F>(
    in_l: *const f32,
    in_r: *const f32,
    out_l: *mut f32,
    out_r: *mut f32,
    n: i32,
    mut f: F,
) where
    F: FnMut(f32, f32) -> (f32, f32),
{
    if n <= 0 || in_l.is_null() || in_r.is_null() || out_l.is_null() || out_r.is_null() {
        return;
    }
    // Rohzeiger statt Slices: in-place ist damit erlaubt (in_l == out_l), was
    // mit `&[f32]` + `&mut [f32]` UB wäre.
    for i in 0..n as usize {
        let l = *in_l.add(i);
        let r = *in_r.add(i);
        let (yl, yr) = f(l, r);
        *out_l.add(i) = yl;
        *out_r.add(i) = yr;
    }
}

// ---------------------------------------------------------------------------
// Speicherverwaltung (unverändert)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests (Host-Target: `cargo test`, kein wasm32-Target nötig)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use core::f32::consts::PI;

    const SR: f32 = 48_000.0;

    /// Analytischer Betrag |H(e^{jw})| aus den Koeffizienten – im Test
    /// unabhängig aus der Übertragungsfunktion hergeleitet, nicht aus der
    /// Implementierung.
    fn magnitude_at(c: &BiquadCoeffs, w: f32) -> f32 {
        let (cw1, sw1) = (w.cos(), w.sin());
        let (cw2, sw2) = ((2.0 * w).cos(), (2.0 * w).sin());
        let num_re = c.b0 + c.b1 * cw1 + c.b2 * cw2;
        let num_im = -(c.b1 * sw1 + c.b2 * sw2);
        let den_re = 1.0 + c.a1 * cw1 + c.a2 * cw2;
        let den_im = -(c.a1 * sw1 + c.a2 * sw2);
        let num = (num_re * num_re + num_im * num_im).sqrt();
        let den = (den_re * den_re + den_im * den_im).sqrt();
        num / den
    }

    /// Messung des Gleichanteils-/Nyquist-Gains in der Zeitdomäne:
    /// DC → konstantes Eingangssignal, Nyquist → alternierendes Vorzeichen.
    /// Beides sind Eigenfunktionen eines stabilen LTI-Systems, der
    /// stationäre Ausgang ist also exakt Eingang * H(z)|_{z=±1}.
    fn measure_dc_gain(kind: i32, cutoff: f32, q: f32) -> f32 {
        let mut bq = StereoBiquad::bypass();
        bq.set(kind, SR, cutoff, q);
        let n = 24_000;
        let mut last = 0.0;
        for i in 0..n {
            let x = 1.0;
            last = bq.process_sample(x, x).0;
            let _ = i;
        }
        last
    }

    fn measure_nyquist_gain(kind: i32, cutoff: f32, q: f32) -> f32 {
        let mut bq = StereoBiquad::bypass();
        bq.set(kind, SR, cutoff, q);
        let n = 24_000;
        let mut last = 0.0;
        for i in 0..n {
            let x = if i % 2 == 0 { 1.0 } else { -1.0 };
            last = bq.process_sample(x, x).0;
        }
        // Der Ausgang alterniert mit dem Eingang → Vorzeichen zurückdrehen.
        let sign = if (n - 1) % 2 == 0 { 1.0 } else { -1.0 };
        last * sign
    }

    fn measure_mag_at(kind: i32, cutoff: f32, q: f32, freq: f32) -> f32 {
        let mut bq = StereoBiquad::bypass();
        bq.set(kind, SR, cutoff, q);
        let n = 48_000;
        let mut peak = 0.0_f32;
        // Einschwingen verwerfen, dann Amplitude im stationären Teil messen.
        for i in 0..n {
            let x = (2.0 * PI * freq * (i as f32) / SR).sin();
            let y = bq.process_sample(x, x).0;
            if i > n / 2 {
                peak = peak.max(y.abs());
            }
        }
        peak
    }

    #[test]
    fn biquad_lowpass_dc_und_nyquist() {
        for &(fc, q) in &[(1_000.0, 0.707), (8_000.0, 4.0), (200.0, 10.0)] {
            let c = BiquadCoeffs::design(FILTER_LOWPASS, SR, fc, q);
            let dc_analytic = magnitude_at(&c, 0.0);
            let ny_analytic = magnitude_at(&c, PI);
            assert!(
                (dc_analytic - 1.0).abs() < 1e-3,
                "LP DC-Gain analytisch {dc_analytic} != 1 (fc={fc})"
            );
            assert!(
                ny_analytic.abs() < 1e-3,
                "LP Nyquist-Gain analytisch {ny_analytic} != 0 (fc={fc})"
            );
            assert!(
                (measure_dc_gain(FILTER_LOWPASS, fc, q) - dc_analytic).abs() < 1e-3,
                "LP DC-Gain gemessen != analytisch (fc={fc}, q={q})"
            );
            assert!(
                (measure_nyquist_gain(FILTER_LOWPASS, fc, q) - ny_analytic).abs() < 1e-3,
                "LP Nyquist-Gain gemessen != analytisch (fc={fc}, q={q})"
            );
        }
    }

    #[test]
    fn biquad_highpass_dc_und_nyquist() {
        for &(fc, q) in &[(1_000.0, 0.707), (8_000.0, 4.0), (200.0, 10.0)] {
            let c = BiquadCoeffs::design(FILTER_HIGHPASS, SR, fc, q);
            let dc_analytic = magnitude_at(&c, 0.0);
            let ny_analytic = magnitude_at(&c, PI);
            assert!((dc_analytic).abs() < 1e-3, "HP DC-Gain {dc_analytic} != 0");
            assert!(
                (ny_analytic - 1.0).abs() < 1e-3,
                "HP Nyquist-Gain {ny_analytic} != 1"
            );
            assert!(
                (measure_dc_gain(FILTER_HIGHPASS, fc, q) - dc_analytic).abs() < 1e-3,
                "HP DC-Gain gemessen != analytisch (fc={fc})"
            );
            assert!(
                (measure_nyquist_gain(FILTER_HIGHPASS, fc, q) - ny_analytic).abs() < 1e-3,
                "HP Nyquist-Gain gemessen != analytisch (fc={fc})"
            );
        }
    }

    #[test]
    fn biquad_bandpass_nullstellen_und_spitze() {
        let fc = 1_000.0;
        let q = 4.0;
        let c = BiquadCoeffs::design(FILTER_BANDPASS, SR, fc, q);
        assert!(magnitude_at(&c, 0.0).abs() < 1e-3, "BP DC != 0");
        assert!(magnitude_at(&c, PI).abs() < 1e-3, "BP Nyquist != 0");
        // 0-dB-Peak-Gain-Form: |H(f0)| = 1
        let peak = magnitude_at(&c, 2.0 * PI * fc / SR);
        assert!((peak - 1.0).abs() < 1e-2, "BP Spitze {peak} != 1");
        let measured = measure_mag_at(FILTER_BANDPASS, fc, q, fc);
        assert!(
            (measured - peak).abs() < 0.02,
            "BP Spitze gemessen {measured} != analytisch {peak}"
        );
    }

    #[test]
    fn biquad_parameter_grenzen_sind_stabil() {
        // Extremwerte dürfen weder NaN noch Panik erzeugen.
        for &(kind, fc, q) in &[
            (FILTER_LOWPASS, -100.0, 0.0),
            (FILTER_HIGHPASS, 1.0e9, 1.0e9),
            (FILTER_BANDPASS, f32::NAN, f32::NAN),
            (99, 1_000.0, 0.707),
        ] {
            let c = BiquadCoeffs::design(kind, SR, fc, q);
            let mut st = BiquadState::new();
            for _ in 0..1_000 {
                let y = st.process(&c, 1.0);
                assert!(y.is_finite(), "instabil bei kind={kind} fc={fc} q={q}");
            }
        }
    }

    #[test]
    fn biquad_ungueltige_samplerate_ist_bypass() {
        let c = BiquadCoeffs::design(FILTER_LOWPASS, 0.0, 1_000.0, 0.707);
        let mut st = BiquadState::new();
        assert_eq!(st.process(&c, 0.25), 0.25);
    }

    #[test]
    fn biquad_nan_vergiftet_zustand_nicht() {
        let c = BiquadCoeffs::design(FILTER_LOWPASS, SR, 1_000.0, 0.707);
        let mut st = BiquadState::new();
        assert_eq!(st.process(&c, f32::NAN), 0.0);
        assert_eq!(st.process(&c, f32::INFINITY), 0.0);
        // Nach dem Ausreißer muss der Filter wieder normal arbeiten.
        for _ in 0..100 {
            assert!(st.process(&c, 0.5).is_finite());
        }
    }

    #[test]
    fn saturation_monoton_und_beschraenkt() {
        let sat = Saturation::new(4.0, 0.5);
        let mut prev = f32::NEG_INFINITY;
        let mut x = -6.0;
        while x <= 6.0 {
            let y = sat.process_sample(x);
            assert!(y >= prev, "nicht monoton bei x={x}: {y} < {prev}");
            assert!(y.abs() <= 0.5 + 1e-6, "|y|={} > trim", y.abs());
            prev = y;
            x += 0.001;
        }
        // Auch für absurde Amplituden bleibt der Ausgang im Trim-Korsett.
        for &big in &[1.0e6, -1.0e6, 1.0e30, -1.0e30] {
            let y = sat.process_sample(big);
            assert!(y.is_finite());
            assert!(y.abs() <= 0.5 + 1e-6);
        }
    }

    #[test]
    fn saturation_kleinsignalverstaerkung_ist_drive_mal_trim() {
        let sat = Saturation::new(4.0, 0.5); // Steigung im Nullpunkt: 2.0
        let x = 1.0e-4;
        let y = sat.process_sample(x);
        assert!(
            (y / x - 2.0).abs() < 1e-2,
            "Kleinsignalverstärkung {} != 2.0",
            y / x
        );
        assert_eq!(sat.process_sample(0.0), 0.0);
        assert_eq!(sat.process_sample(f32::NAN), 0.0);
    }

    /// Statische Gain-Reduktion nach der Kennlinie (unabhängige Formel).
    fn expected_static_gr_db(level_db: f32, threshold_db: f32, ratio: f32) -> f32 {
        if level_db > threshold_db {
            (threshold_db - level_db) * (1.0 - 1.0 / ratio)
        } else {
            0.0
        }
    }

    #[test]
    fn kompressor_gain_reduction_nach_attack_zeit() {
        let sr = SR;
        let threshold = -20.0;
        let ratio = 4.0;
        let attack = 0.01;
        let release = 0.2;
        let mut comp = Compressor::new(sr, threshold, ratio, attack, release);

        // Sprung von Stille auf 0.5 (-6,02 dB) → voller Überschuss.
        let level_db = 20.0 * 0.5_f32.log10();
        let target = expected_static_gr_db(level_db, threshold, ratio);
        assert!(target < -10.0 && target > -11.0, "Testannahme: {target}");

        let n_attack = (attack * sr).round() as usize;
        let mut gr_at_attack = 0.0;
        let mut gr_after_8x = 0.0;
        for i in 0..n_attack * 8 {
            let (l, r) = comp.process_sample(0.5, 0.5);
            assert_eq!(l, r, "stereo-verkoppelt: beide Kanäle gleich");
            if i + 1 == n_attack {
                gr_at_attack = comp.gain_db();
            }
            gr_after_8x = comp.gain_db();
        }

        // Nach genau einer Attack-Zeitkonstante: 1 - 1/e = 63,2 % des Ziels.
        let frac = gr_at_attack / target;
        assert!(
            (frac - 0.632).abs() < 0.02,
            "GR nach Attack = {frac} des Ziels (erwartet 0,632)"
        );
        // Nach 8 Zeitkonstanten ist das Ziel praktisch erreicht.
        assert!(
            (gr_after_8x - target).abs() < 0.05,
            "GR nach 8x Attack = {gr_after_8x}, Ziel {target}"
        );
        // Kein Überschwingen (Ein-Pol).
        assert!(gr_after_8x >= target, "Überschwingen: {gr_after_8x} < {target}");
    }

    #[test]
    fn kompressor_unter_threshold_bleibt_unveraendert() {
        let mut comp = Compressor::new(SR, -20.0, 4.0, 0.01, 0.2);
        for _ in 0..4_800 {
            let (l, r) = comp.process_sample(0.05, -0.05);
            assert!((l - 0.05).abs() < 1e-6);
            assert!((r + 0.05).abs() < 1e-6);
        }
        assert_eq!(comp.gain_db(), 0.0);
    }

    #[test]
    fn kompressor_stereo_link_nutzt_den_lauteren_kanal() {
        let mut comp = Compressor::new(SR, -20.0, 4.0, 0.001, 0.2);
        // R ist laut, L leise: L muss denselben Gain sehen wie R.
        for _ in 0..48_000 {
            comp.process_sample(0.01, 0.5);
        }
        let gr = comp.gain_db();
        let mut comp2 = Compressor::new(SR, -20.0, 4.0, 0.001, 0.2);
        for _ in 0..48_000 {
            comp2.process_sample(0.5, 0.5);
        }
        assert!((gr - comp2.gain_db()).abs() < 1e-6, "Link nutzt nicht das Maximum");
        assert!(gr < -10.0);
    }

    #[test]
    fn kompressor_release_erholt_sich() {
        let mut comp = Compressor::new(SR, -20.0, 4.0, 0.005, 0.05);
        for _ in 0..24_000 {
            comp.process_sample(0.5, 0.5);
        }
        let held = comp.gain_db();
        assert!(held < -10.0);
        // Stille: Release über ~8 Zeitkonstanten → zurück auf 0 dB.
        for _ in 0..((0.05 * SR) as usize * 8) {
            comp.process_sample(0.0, 0.0);
        }
        assert!(
            comp.gain_db() > -0.05,
            "Release unvollständig: {} dB",
            comp.gain_db()
        );
    }

    #[test]
    fn kompressor_ratio_eins_ist_durchreiche() {
        let mut comp = Compressor::new(SR, -20.0, 1.0, 0.001, 0.001);
        for _ in 0..1_000 {
            let (l, _) = comp.process_sample(0.9, 0.9);
            assert!((l - 0.9).abs() < 1e-6);
        }
        assert_eq!(comp.gain_db(), 0.0);
    }

    #[test]
    fn gain_kern_bleibt_bit_identisch_zur_c_vorlage() {
        let input = [0.5_f32, -0.25, 0.0, f32::NAN, 2.0];
        let mut out = [0.0_f32; 5];
        apply_gain(&input, &mut out, 2.0);
        assert_eq!(out, [1.0, -0.5, 0.0, 0.0, 4.0]);
    }
}
