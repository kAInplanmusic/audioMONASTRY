use napi_derive::napi;
use napi::bindgen_prelude::*;

#[napi]
pub fn mix_audio(buffer1: Float32Array, buffer2: Float32Array) -> Float32Array {
    let b1 = buffer1.as_ref();
    let b2 = buffer2.as_ref();
    let mixed: Vec<f32> = b1.iter().zip(b2.iter()).map(|(a, b)| a + b).collect();
    Float32Array::new(mixed)
}
