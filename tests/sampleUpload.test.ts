import { describe, expect, it } from 'vitest';
import {
  validateAudioFile, tagsFrom, localSampleId, uploadObjectKey, UPLOAD_KINDS,
} from '../src/utils/sampleUpload';

describe('Sample-Upload-Helfer', () => {
  it('validiert erlaubte Audio-Formate', () => {
    expect(validateAudioFile('kick.wav', 'audio/wav').ok).toBe(true);
    expect(validateAudioFile('loop.mp3', '').ok).toBe(true);
    expect(validateAudioFile('loop.flac', 'audio/flac').ok).toBe(true);
    expect(validateAudioFile('virus.exe', 'application/octet-stream').ok).toBe(false);
  });

  it('ergänzt Pflicht-Tags (kind + Format) und dedupliziert', () => {
    expect(tagsFrom('acid, 808', 'sample', 'wav')).toEqual(['sample', 'wav', 'acid', '808']);
    expect(tagsFrom('sample, sample', 'sample', 'wav')).toEqual(['sample', 'wav']);
  });

  it('baut stabile lokale IDs und Server-Keys', () => {
    expect(localSampleId('sample', 'My Kick!')).toMatch(/^sample-/);
    expect(localSampleId('sample', 'My Kick!')).not.toContain(' ');
    expect(uploadObjectKey('sample', 'My Kick', 'wav')).toMatch(/^uploads\/samples\/\d+-my-kick\.wav$/);
  });

  it('kennt alle Upload-Kinds', () => {
    expect(UPLOAD_KINDS).toEqual(['sample', 'recording', 'stem', 'sound', 'voice']);
  });
});
