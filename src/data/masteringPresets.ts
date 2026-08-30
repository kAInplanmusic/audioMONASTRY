export type BiquadFilterType = 'lowpass' | 'highpass' | 'bandpass' | 'lowshelf' | 'highshelf' | 'peaking' | 'notch' | 'allpass';
export const MASTERING_PRESETS = {
  'techno_club': {
    name: 'Techno Club',
    master_me: { input_gain: 0, highpass_freq: 25, tilt_gain: -1.5, target_loudness: -10, strength: 65, attack: 5, release: 80, limiter_threshold: -1 },
    tone_shift: { tilt_gain: -1, bands: [ {freq: 40, gain: 3, q: 1.5, type: 'lowshelf'}, {freq: 80, gain: 1, q: 2.0}, {freq: 150, gain: -2, q: 2.5}, {freq: 300, gain: -1.5, q: 2.0}, {freq: 500, gain: 0, q: 1.0}, {freq: 1000, gain: 1, q: 1.5}, {freq: 2500, gain: -2, q: 2.0}, {freq: 4000, gain: 1.5, q: 1.5}, {freq: 8000, gain: 2, q: 1.0, type: 'highshelf'}, {freq: 12000, gain: 1, q: 1.0, type: 'highshelf'}, {freq: 16000, gain: 0, q: 1.0}, {freq: 20000, gain: 0, q: 1.0} ] }
  },
  'goa': {
    name: 'Goa',
    master_me: { input_gain: 1, highpass_freq: 30, tilt_gain: 0, target_loudness: -11, strength: 50, attack: 8, release: 100, limiter_threshold: -1 },
    tone_shift: { tilt_gain: 0.5, bands: [ {freq: 45, gain: 2, q: 1.5, type: 'lowshelf'}, {freq: 90, gain: 1.5, q: 2.0}, {freq: 200, gain: -1, q: 2.5}, {freq: 400, gain: -1, q: 2.0}, {freq: 800, gain: 0, q: 1.0}, {freq: 1500, gain: 1.5, q: 1.5}, {freq: 3000, gain: 2, q: 2.0}, {freq: 5000, gain: 1, q: 1.5}, {freq: 9000, gain: 2.5, q: 1.0, type: 'highshelf'}, {freq: 14000, gain: 1.5, q: 1.0, type: 'highshelf'}, {freq: 16000, gain: 0, q: 1.0}, {freq: 20000, gain: 0, q: 1.0} ] }
  },
  'psytrance': {
    name: 'Psytrance',
    master_me: { input_gain: 2, highpass_freq: 35, tilt_gain: 0.5, target_loudness: -9, strength: 70, attack: 3, release: 60, limiter_threshold: -0.5 },
    tone_shift: { tilt_gain: 1, bands: [ {freq: 50, gain: 3.5, q: 1.5, type: 'lowshelf'}, {freq: 100, gain: 2, q: 2.0}, {freq: 250, gain: -2.5, q: 2.5}, {freq: 500, gain: -1.5, q: 2.0}, {freq: 1000, gain: 0.5, q: 1.0}, {freq: 2000, gain: 2, q: 1.5}, {freq: 4000, gain: 2.5, q: 2.0}, {freq: 6000, gain: 1.5, q: 1.5}, {freq: 10000, gain: 3, q: 1.0, type: 'highshelf'}, {freq: 15000, gain: 2, q: 1.0, type: 'highshelf'}, {freq: 18000, gain: 1, q: 1.0}, {freq: 20000, gain: 0, q: 1.0} ] }
  },
  'bounce': {
    name: 'Bounce',
    master_me: { input_gain: 1, highpass_freq: 40, tilt_gain: -0.5, target_loudness: -10, strength: 60, attack: 6, release: 90, limiter_threshold: -1 },
    tone_shift: { tilt_gain: 0, bands: [ {freq: 60, gain: 3, q: 1.5, type: 'lowshelf'}, {freq: 120, gain: 2, q: 2.0}, {freq: 300, gain: -1.5, q: 2.5}, {freq: 600, gain: -1, q: 2.0}, {freq: 1200, gain: 1, q: 1.0}, {freq: 2500, gain: 1.5, q: 1.5}, {freq: 5000, gain: -1, q: 2.0}, {freq: 8000, gain: 2, q: 1.5}, {freq: 12000, gain: 1.5, q: 1.0, type: 'highshelf'}, {freq: 16000, gain: 1, q: 1.0, type: 'highshelf'}, {freq: 18000, gain: 0, q: 1.0}, {freq: 20000, gain: 0, q: 1.0} ] }
  },
  'hard_bounce': {
    name: 'Hard Bounce',
    master_me: { input_gain: 3, highpass_freq: 40, tilt_gain: -1, target_loudness: -8, strength: 80, attack: 2, release: 50, limiter_threshold: -0.2 },
    tone_shift: { tilt_gain: 0.5, bands: [ {freq: 55, gain: 4, q: 1.5, type: 'lowshelf'}, {freq: 110, gain: 2.5, q: 2.0}, {freq: 250, gain: -3, q: 2.5}, {freq: 500, gain: -1.5, q: 2.0}, {freq: 1000, gain: 1, q: 1.0}, {freq: 2500, gain: 2, q: 1.5}, {freq: 4500, gain: -1.5, q: 2.0}, {freq: 8000, gain: 2.5, q: 1.5}, {freq: 12000, gain: 2, q: 1.0, type: 'highshelf'}, {freq: 16000, gain: 1.5, q: 1.0, type: 'highshelf'}, {freq: 18000, gain: 0, q: 1.0}, {freq: 20000, gain: 0, q: 1.0} ] }
  },
  'peak_time_techno': {
    name: 'Peak Time Techno',
    master_me: { input_gain: 2, highpass_freq: 28, tilt_gain: -1, target_loudness: -9, strength: 75, attack: 4, release: 70, limiter_threshold: -0.5 },
    tone_shift: { tilt_gain: 0, bands: [ {freq: 45, gain: 3.5, q: 1.5, type: 'lowshelf'}, {freq: 90, gain: 1.5, q: 2.0}, {freq: 200, gain: -2, q: 2.5}, {freq: 400, gain: -1.5, q: 2.0}, {freq: 800, gain: 0, q: 1.0}, {freq: 1500, gain: 1, q: 1.5}, {freq: 3000, gain: -1, q: 2.0}, {freq: 5000, gain: 1.5, q: 1.5}, {freq: 9000, gain: 2.5, q: 1.0, type: 'highshelf'}, {freq: 14000, gain: 1.5, q: 1.0, type: 'highshelf'}, {freq: 16000, gain: 0, q: 1.0}, {freq: 20000, gain: 0, q: 1.0} ] }
  },
  'hardcore': {
    name: 'Hardcore',
    master_me: { input_gain: 4, highpass_freq: 35, tilt_gain: 0.5, target_loudness: -7, strength: 90, attack: 1, release: 40, limiter_threshold: -0.1 },
    tone_shift: { tilt_gain: 1.5, bands: [ {freq: 60, gain: 4, q: 1.5, type: 'lowshelf'}, {freq: 150, gain: 2.5, q: 2.0}, {freq: 300, gain: -3.5, q: 2.5}, {freq: 600, gain: -2, q: 2.0}, {freq: 1200, gain: 1.5, q: 1.0}, {freq: 2500, gain: 3, q: 1.5}, {freq: 4000, gain: -2, q: 2.0}, {freq: 7000, gain: 3, q: 1.5}, {freq: 11000, gain: 2.5, q: 1.0, type: 'highshelf'}, {freq: 15000, gain: 2, q: 1.0, type: 'highshelf'}, {freq: 18000, gain: 1, q: 1.0}, {freq: 20000, gain: 0, q: 1.0} ] }
  },
  'house': {
    name: 'House',
    master_me: { input_gain: 0, highpass_freq: 30, tilt_gain: 0, target_loudness: -12, strength: 50, attack: 10, release: 120, limiter_threshold: -1.5 },
    tone_shift: { tilt_gain: 0, bands: [ {freq: 55, gain: 2, q: 1.5, type: 'lowshelf'}, {freq: 110, gain: 1, q: 2.0}, {freq: 250, gain: -1.5, q: 2.5}, {freq: 500, gain: -1, q: 2.0}, {freq: 1000, gain: 0, q: 1.0}, {freq: 2000, gain: 1, q: 1.5}, {freq: 4000, gain: 0, q: 2.0}, {freq: 8000, gain: 1.5, q: 1.5}, {freq: 12000, gain: 1, q: 1.0, type: 'highshelf'}, {freq: 16000, gain: 0.5, q: 1.0, type: 'highshelf'}, {freq: 18000, gain: 0, q: 1.0}, {freq: 20000, gain: 0, q: 1.0} ] }
  },
  'trance': {
    name: 'Trance',
    master_me: { input_gain: 1, highpass_freq: 35, tilt_gain: 0.5, target_loudness: -11, strength: 55, attack: 8, release: 110, limiter_threshold: -1 },
    tone_shift: { tilt_gain: 0.5, bands: [ {freq: 50, gain: 2.5, q: 1.5, type: 'lowshelf'}, {freq: 100, gain: 1.5, q: 2.0}, {freq: 250, gain: -2, q: 2.5}, {freq: 500, gain: -1.5, q: 2.0}, {freq: 1000, gain: 0.5, q: 1.0}, {freq: 2000, gain: 1.5, q: 1.5}, {freq: 4000, gain: -1, q: 2.0}, {freq: 8000, gain: 2, q: 1.5}, {freq: 12000, gain: 1.5, q: 1.0, type: 'highshelf'}, {freq: 16000, gain: 1, q: 1.0, type: 'highshelf'}, {freq: 18000, gain: 0, q: 1.0}, {freq: 20000, gain: 0, q: 1.0} ] }
  },
  'cinematic_techno': {
    name: 'Cinematic Techno',
    master_me: { input_gain: 0, highpass_freq: 20, tilt_gain: -0.5, target_loudness: -14, strength: 40, attack: 15, release: 180, limiter_threshold: -2 },
    tone_shift: { tilt_gain: -0.5, bands: [ {freq: 35, gain: 3, q: 1.5, type: 'lowshelf'}, {freq: 70, gain: 1, q: 2.0}, {freq: 150, gain: -1.5, q: 2.5}, {freq: 300, gain: -2, q: 2.0}, {freq: 600, gain: 0, q: 1.0}, {freq: 1200, gain: -1, q: 1.5}, {freq: 2500, gain: 1, q: 2.0}, {freq: 5000, gain: 1.5, q: 1.5}, {freq: 10000, gain: 2, q: 1.0, type: 'highshelf'}, {freq: 15000, gain: 1.5, q: 1.0, type: 'highshelf'}, {freq: 18000, gain: 0, q: 1.0}, {freq: 20000, gain: 0, q: 1.0} ] }
  }
};
