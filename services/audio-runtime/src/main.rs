//! audioMONASTRY-runtime – Nativer Audio-Prozess (Phase 2, real DSP + Streaming)
//!
//! Liest JSON-Zeilen vom stdin und antwortet mit JSON-Zeilen auf stdout.
//! - device.list: echte Audio-Geräte über cpal
//! - device.open: startet einen 440-Hz-Testton-Stream (echtes Streaming)
//! - graph.process / render.offline: verarbeitet PCM-f32-Base64 mit Gain + Drive (Tanh)

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

#[derive(Debug, Deserialize)]
struct IpcMessage {
    #[serde(default)]
    channel: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Serialize)]
struct IpcResponse {
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<Value>,
}

#[derive(Debug, Serialize, Clone)]
struct AudioDevice {
    id: String,
    name: String,
    direction: String,
}

fn list_devices_cpal() -> Vec<AudioDevice> {
    let mut devices = Vec::new();
    let host = cpal::default_host();

    if let Ok(outputs) = host.output_devices() {
        for device in outputs {
            let name = device.name().unwrap_or_else(|_| "Output Device".to_string());
            devices.push(AudioDevice {
                id: format!("out:{name}"),
                name: name.clone(),
                direction: "output".to_string(),
            });
        }
    }

    if let Ok(inputs) = host.input_devices() {
        for device in inputs {
            let name = device.name().unwrap_or_else(|_| "Input Device".to_string());
            devices.push(AudioDevice {
                id: format!("in:{name}"),
                name,
                direction: "input".to_string(),
            });
        }
    }

    if devices.is_empty() {
        devices.push(AudioDevice {
            id: "default".to_string(),
            name: "Default Audio Device".to_string(),
            direction: "output".to_string(),
        });
    }
    devices
}

/// Startet einen echten 440-Hz-Testton-Stream auf dem Gerät.
fn start_tone_stream(device: &cpal::Device) -> Result<(), String> {
    let default_config = device.default_output_config().map_err(|e| e.to_string())?;
    let sample_format = default_config.sample_format();
    let config: cpal::StreamConfig = default_config.into();
    let sample_rate = config.sample_rate.0;

    match sample_format {
        cpal::SampleFormat::F32 => {
            let phase = Arc::new(AtomicU64::new(0));
            let stream = device
                .build_output_stream(
                    &config,
                    move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                        for sample in data.iter_mut() {
                            let p = phase.fetch_add(1, Ordering::Relaxed) as f32;
                            *sample = (2.0 * std::f32::consts::PI * 440.0 * p / sample_rate as f32).sin() * 0.12;
                        }
                    },
                    |err| eprintln!("[runtime] audio error: {err}"),
                    None,
                )
                .map_err(|e| e.to_string())?;
            stream.play().map_err(|e| e.to_string())?;
        }
        cpal::SampleFormat::I16 => {
            let phase = Arc::new(AtomicU64::new(0));
            let stream = device
                .build_output_stream(
                    &config,
                    move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                        for sample in data.iter_mut() {
                            let p = phase.fetch_add(1, Ordering::Relaxed) as f32;
                            let v = (2.0 * std::f32::consts::PI * 440.0 * p / sample_rate as f32).sin() * 0.12;
                            *sample = (v * 32767.0) as i16;
                        }
                    },
                    |err| eprintln!("[runtime] audio error: {err}"),
                    None,
                )
                .map_err(|e| e.to_string())?;
            stream.play().map_err(|e| e.to_string())?;
        }
        other => return Err(format!("Sample-Format {other:?} noch nicht unterstützt")),
    }

    // Stream-Thread am Leben halten (detached).
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3600));
    });
    Ok(())
}

fn open_device(device_id: &str) -> Result<Value, String> {
    let host = cpal::default_host();
    let devices: Vec<cpal::Device> = host
        .output_devices()
        .map_err(|e| e.to_string())?
        .collect::<Vec<_>>();

    let name = device_id.strip_prefix("out:").unwrap_or(device_id);
    let device = devices
        .into_iter()
        .find(|d| d.name().map(|n| n == name).unwrap_or(false))
        .ok_or_else(|| format!("Output-Gerät nicht gefunden: {device_id}"))?;

    start_tone_stream(&device)?;
    Ok(json!({ "opened": true, "deviceId": device_id, "stream": "440hz-test-tone" }))
}

/// Biquad (RBJ) für 3-Band-Peaking-EQ in der Mastering-Kette.
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    fn peaking(sample_rate: f32, freq: f32, q: f32, gain_db: f32) -> Self {
        let a = 10_f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * freq / sample_rate;
        let alpha = w0.sin() / (2.0 * q);
        let cos_w0 = w0.cos();

        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos_w0;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha / a;

        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// PCM-f32-Base64 verarbeiten: 3-Band-EQ → Drive (tanh) → Ceiling → Gain.
fn process_pcm(payload: &Value) -> Result<Value, String> {
    let input_b64 = payload
        .get("input_base64")
        .and_then(Value::as_str)
        .ok_or_else(|| "input_base64 fehlt".to_string())?;
    let gain = payload.get("gain").and_then(Value::as_f64).unwrap_or(1.0) as f32;
    let drive = payload.get("drive").and_then(Value::as_f64).unwrap_or(1.0) as f32;
    let ceiling = payload.get("ceiling").and_then(Value::as_f64).unwrap_or(1.0) as f32;
    let eq_low_db = payload.get("eq_low_db").and_then(Value::as_f64).unwrap_or(0.0) as f32;
    let eq_mid_db = payload.get("eq_mid_db").and_then(Value::as_f64).unwrap_or(0.0) as f32;
    let eq_high_db = payload.get("eq_high_db").and_then(Value::as_f64).unwrap_or(0.0) as f32;
    let sample_rate = payload.get("sample_rate").and_then(Value::as_f64).unwrap_or(48000.0) as f32;
    let channels = payload.get("channels").and_then(Value::as_u64).unwrap_or(1).clamp(1, 8) as usize;

    let bytes = B64.decode(input_b64).map_err(|e| e.to_string())?;
    let samples: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    let mut samples = if samples.is_empty() { vec![0.0; 128 * channels] } else { samples };

    // Mastering-Kette pro Kanal: 3-Band-EQ → Drive (tanh) → Ceiling → Gain.
    let block_len = samples.len() / channels;
    for ch in 0..channels {
        let mut eq_low = Biquad::peaking(sample_rate, 120.0, 0.707, eq_low_db);
        let mut eq_mid = Biquad::peaking(sample_rate, 1000.0, 0.707, eq_mid_db);
        let mut eq_high = Biquad::peaking(sample_rate, 8000.0, 0.707, eq_high_db);

        for i in 0..block_len {
            let idx = i * channels + ch;
            let sample = samples[idx];
            let x = eq_high.process(eq_mid.process(eq_low.process(sample)));
            samples[idx] = (x.tanh() * drive).clamp(-ceiling.abs(), ceiling.abs()) * gain;
        }
    }

    let out_bytes: Vec<u8> = samples
        .iter()
        .flat_map(|s| s.to_le_bytes())
        .collect();
    Ok(json!({
        "output_base64": B64.encode(&out_bytes),
        "samples": samples.len(),
        "gain": gain,
        "drive": drive,
        "ceiling": ceiling,
        "eq_low_db": eq_low_db,
        "eq_mid_db": eq_mid_db,
        "eq_high_db": eq_high_db,
    }))
}

fn handle(message: &IpcMessage) -> IpcResponse {
    match message.channel.as_str() {
        "ping" => IpcResponse {
            id: message.id.clone(),
            ok: true,
            error: None,
            payload: Some(json!({ "pong": true, "runtime": "audiomonastry-runtime" })),
        },
        "device.list" => IpcResponse {
            id: message.id.clone(),
            ok: true,
            error: None,
            payload: Some(json!({ "devices": list_devices_cpal() })),
        },
        "device.open" => {
            let device_id = message
                .payload
                .get("deviceId")
                .and_then(Value::as_str)
                .unwrap_or("default");
            match open_device(device_id) {
                Ok(payload) => IpcResponse {
                    id: message.id.clone(),
                    ok: true,
                    error: None,
                    payload: Some(payload),
                },
                Err(err) => IpcResponse {
                    id: message.id.clone(),
                    ok: false,
                    error: Some(err),
                    payload: None,
                },
            }
        }
        "graph.process" | "render.offline" => match process_pcm(&message.payload) {
            Ok(payload) => IpcResponse {
                id: message.id.clone(),
                ok: true,
                error: None,
                payload: Some(payload),
            },
            Err(err) => IpcResponse {
                id: message.id.clone(),
                ok: false,
                error: Some(err),
                payload: None,
            },
        },
        "graph.sync" => IpcResponse {
            id: message.id.clone(),
            ok: true,
            error: None,
            payload: Some(json!({ "accepted": true, "channel": message.channel })),
        },
        other => IpcResponse {
            id: message.id.clone(),
            ok: false,
            error: Some(format!("Unbekannter Channel: {other}")),
            payload: None,
        },
    }
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<IpcMessage>(&line) {
            Ok(message) => handle(&message),
            Err(err) => IpcResponse {
                id: String::new(),
                ok: false,
                error: Some(format!("Ungültiges JSON: {err}")),
                payload: None,
            },
        };
        if let Ok(out) = serde_json::to_string(&response) {
            let _ = writeln!(stdout, "{out}");
            let _ = stdout.flush();
        }
    }
}
