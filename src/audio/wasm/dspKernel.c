/*
 * audioMONASTRY · 8.1.2 – WASM-DSP-Kernel (Referenz)
 * Einfacher, performanter Mix/Gain-Kern (2 Kanäle), exportiert als dsp_process.
 */
#include <stdint.h>
#include <math.h>

void dsp_process(float* in_l, float* in_r, float* out_l, float* out_r,
                 int n, float gain) {
  for (int i = 0; i < n; i++) {
    float l = in_l[i] * gain;
    float r = in_r[i] * gain;
    out_l[i] = isfinite(l) ? l : 0.0f;
    out_r[i] = isfinite(r) ? r : 0.0f;
  }
}
