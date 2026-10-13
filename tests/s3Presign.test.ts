// FLEET-P1-006: SigV4-Presign ohne Zusatzpaket – gleicher Testvektor wie
// tests/test_s3lite.py (AWS-Doku "Authenticating Requests: Using Query Parameters").
import { describe, expect, it } from 'vitest';
import { presignUrl } from '../server/s3Presign';

const WHEN = new Date(Date.UTC(2013, 4, 24, 0, 0, 0));
const AWS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

describe('presignUrl (SigV4 Query-Signatur)', () => {
  it('entspricht dem AWS-Beispiel (virtueller Host)', () => {
    const url = presignUrl({ endpoint: 'https://examplebucket.s3.amazonaws.com', bucket: '', region: 'us-east-1', ...AWS }, 'GET', 'test.txt', 86400, WHEN);
    expect(url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?')).toBe(true);
    expect(url).toContain('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request');
    expect(url.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')).toBe(true);
  });

  it('Pfad-Stil fuer R2 mit kodiertem Key, PUT', () => {
    const url = presignUrl({ endpoint: 'https://acc.r2.cloudflarestorage.com/', bucket: 'audiomonastry', ...AWS }, 'PUT', 'uploads/stems/a b-vocals.wav', 60, WHEN);
    expect(url.startsWith('https://acc.r2.cloudflarestorage.com/audiomonastry/uploads/stems/a%20b-vocals.wav?')).toBe(true);
    expect(url).toContain('%2Fauto%2Fs3%2Faws4_request');
    expect(url).toContain('X-Amz-Expires=60');
    expect(url).not.toContain(AWS.secretAccessKey);
  });

  it('lehnt unsinnige Gueltigkeit ab', () => {
    expect(() => presignUrl({ endpoint: 'https://x.example', bucket: 'b', ...AWS }, 'PUT', 'k', 0)).toThrow();
    expect(() => presignUrl({ endpoint: 'https://x.example', bucket: 'b', ...AWS }, 'PUT', 'k', 700_000)).toThrow();
  });
});
