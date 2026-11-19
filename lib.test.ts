import { describe, expect, it } from 'vitest';

import {
  analyzeBucket,
  bandColor,
  bucketForProgress,
  computeFullPeaks,
  extractInitSegment,
  looksLikeInitSegment,
  playedCoverage,
  runBucketRange,
  sampleWindowForBucket,
  shouldAutoFetchFull,
  startsAtFragmentBoundary,
  stripDuplicateInit,
} from './lib';

describe('bucketForProgress', () => {
  it('maps progress to a clamped bucket index', () => {
    expect(bucketForProgress(0, 2000)).toBe(0);
    expect(bucketForProgress(0.5, 2000)).toBe(1000);
    expect(bucketForProgress(1, 2000)).toBe(1999); // clamped to res-1
    expect(bucketForProgress(-0.2, 2000)).toBe(0); // clamped low
    expect(bucketForProgress(2, 2000)).toBe(1999); // clamped high
  });
});

describe('runBucketRange', () => {
  it('covers the whole track for a start-anchored run', () => {
    expect(runBucketRange(0, 30, 300, 2000)).toEqual({ start: 0, end: 200 });
  });

  it('places a seeked run at its own offset, NOT at 0', () => {
    // This is the regression: seeking to 150s must land at bucket 1000, not 0.
    expect(runBucketRange(150, 30, 300, 2000)).toEqual({ start: 1000, end: 1200 });
  });

  it('clamps to [0, res]', () => {
    const r = runBucketRange(290, 60, 300, 2000); // runs past the end
    expect(r.start).toBe(Math.floor(290 / (300 / 2000)));
    expect(r.end).toBe(2000);
    expect(runBucketRange(0, 0, 300, 2000)).toEqual({ start: 0, end: 0 }); // empty
  });

  it('is safe for a zero-length track', () => {
    expect(runBucketRange(0, 30, 0, 2000)).toEqual({ start: 0, end: 0 });
  });
});

describe('sampleWindowForBucket', () => {
  const sr = 48000;
  const len = sr * 30; // 30s of audio

  it('maps a bucket to the right sample window within its run', () => {
    // run starts at 150s; bucket 1000 == time 150s == sample 0 of this run.
    const w = sampleWindowForBucket(1000, 150, 300, 2000, sr, len);
    expect(w).toEqual({ start: 0, end: Math.floor((300 / 2000) * sr) });
  });

  it('returns null for a bucket before the run starts', () => {
    expect(sampleWindowForBucket(500, 150, 300, 2000, sr, len)).toBeNull();
  });

  it('fills the partial boundary bucket at a seek point (not grey)', () => {
    // Seek to 150.075s — between bucket 1000 (150.0s) and 1001 (150.15s). The first
    // touched bucket is 1000, which starts just before the run: clamp to sample 0, but
    // only read up to the bucket's own end (not a full bucket past it).
    const w = sampleWindowForBucket(1000, 150.075, 300, 2000, sr, len);
    expect(w).not.toBeNull();
    expect(w!.start).toBe(0);
    expect(w!.end).toBe(Math.floor((150.15 - 150.075) * sr));
  });

  it('shares boundaries between adjacent buckets (no gaps, no overlap)', () => {
    // 10s track, 2000 buckets, 44.1kHz: the bot's example — windows must tile exactly.
    const sr44 = 44100;
    const len44 = sr44 * 10;
    const wb = sampleWindowForBucket(440, 0, 10, 2000, sr44, len44);
    const wa = sampleWindowForBucket(441, 0, 10, 2000, sr44, len44);
    expect(wb).not.toBeNull();
    expect(wa).not.toBeNull();
    expect(wa!.start).toBe(wb!.end); // contiguous: no skipped sample, no double-read
  });

  it('still skips a bucket that is more than one bucket before the run', () => {
    // bucket 998 == 149.7s, a full bucket before a run at 150.075s → no overlap.
    expect(sampleWindowForBucket(998, 150.075, 300, 2000, sr, len)).toBeNull();
  });

  it('returns null for a bucket past the run audio', () => {
    // run start 150s, only 30s decoded → bucket at 200s is out of range.
    const bucketAt200s = Math.floor(200 / (300 / 2000));
    expect(sampleWindowForBucket(bucketAt200s, 150, 300, 2000, sr, len)).toBeNull();
  });

  it('clips the final window to the available samples', () => {
    const lastBucket = Math.floor(179 / (300 / 2000)); // near the end of a 150–180s run
    const w = sampleWindowForBucket(lastBucket, 150, 300, 2000, sr, len);
    expect(w).not.toBeNull();
    expect(w!.end).toBeLessThanOrEqual(len);
  });
});

describe('computeFullPeaks (opt-in full-waveform path)', () => {
  const sr = 48000;
  const res = 200;
  const dur = 4; // seconds
  const len = sr * dur;

  it('fills every timeline bucket for a whole decoded track', () => {
    const sig = fill(len, () => 0.5);
    const { peaks, filled, peakScale } = computeFullPeaks([sig], sr, dur, res);
    expect(filled.length).toBe(res);
    // Every bucket has samples → all filled.
    expect(Array.from(filled).every((v) => v === 1)).toBe(true);
    // Constant 0.5 amplitude → rms ~0.5 everywhere, normalized to the 0.92 target.
    expect(peaks[0]).toBeCloseTo(0.5, 2);
    expect(peaks[0] * peakScale).toBeCloseTo(0.92, 2);
  });

  it('normalizes so the LOUDEST bucket hits the target and quieter ones scale below it', () => {
    // First half full-scale, second half quarter-scale.
    const sig = fill(len, (i) => (i < len / 2 ? 1 : 0.25));
    const { peaks, peakScale } = computeFullPeaks([sig], sr, dur, res);
    const loud = peaks[10] * peakScale; // in the loud half
    const quiet = peaks[res - 10] * peakScale; // in the quiet half
    expect(loud).toBeCloseTo(0.92, 2);
    expect(quiet).toBeGreaterThan(0);
    expect(quiet).toBeLessThan(loud);
    expect(quiet / loud).toBeCloseTo(0.25, 1);
  });

  it('splits energy into bands (low-frequency track → low band dominant)', () => {
    // ~40Hz sine: energy sits in the low band.
    const sig = fill(len, (i) => Math.sin((2 * Math.PI * 40 * i) / sr));
    const { bands } = computeFullPeaks([sig], sr, dur, res);
    const b = 100;
    expect(bands[b * 3]).toBeGreaterThan(bands[b * 3 + 2]); // low > high
  });

  it('fills EVERY bucket with no holes at the real RES=2000 (rock-solid guarantee)', () => {
    // A full-length track must produce a complete, hole-free waveform: every bucket
    // decoded, every peak finite. This is the property the full-waveform path relies on.
    const RES = 2000;
    const trackDur = 380; // ~6:20
    const sr = 44100;
    const total = Math.floor(sr * trackDur);
    const sig = new Float32Array(total);
    for (let i = 0; i < total; i++) sig[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.6;
    const { peaks, filled } = computeFullPeaks([sig], sr, trackDur, RES);
    expect(filled.length).toBe(RES);
    let holes = 0;
    let nonFinite = 0;
    for (let b = 0; b < RES; b++) {
      if (filled[b] !== 1) holes++;
      if (!Number.isFinite(peaks[b])) nonFinite++;
    }
    expect(holes).toBe(0);
    expect(nonFinite).toBe(0);
  });

  it('is deterministic — same input yields identical bars (bars never move)', () => {
    const sig = fill(len, (i) => Math.sin(i / 50) * 0.5);
    const a = computeFullPeaks([sig], sr, dur, res);
    const b = computeFullPeaks([sig], sr, dur, res);
    expect(Array.from(a.peaks)).toEqual(Array.from(b.peaks));
    expect(a.peakScale).toBe(b.peakScale);
  });

  it('is safe for silence: no NaN, peakScale falls back to 1', () => {
    const sig = fill(len, () => 0);
    const { peaks, peakScale, filled } = computeFullPeaks([sig], sr, dur, res);
    expect(peakScale).toBe(1);
    expect(peaks[0]).toBe(0);
    expect(Array.from(filled).every((v) => v === 1)).toBe(true);
  });

  it('handles a zero-length decode without throwing', () => {
    const { filled, peakScale } = computeFullPeaks([new Float32Array(0)], sr, 0, res);
    expect(peakScale).toBe(1);
    expect(Array.from(filled).every((v) => v === 0)).toBe(true);
  });
});

describe('playedCoverage', () => {
  const none = (n: number) => new Uint8Array(n);

  it('is 1 when nothing has played yet (never looks uncovered)', () => {
    expect(playedCoverage(none(100), none(100), 0)).toBe(1);
    expect(playedCoverage(none(100), none(100), -5)).toBe(1);
  });

  it('reports the fraction of the played region that is decoded', () => {
    const filled = new Uint8Array(100);
    for (let i = 0; i <= 50; i++) filled[i] = 1; // first 51 buckets decoded
    expect(playedCoverage(filled, none(100), 50)).toBe(1); // played region fully covered
    expect(playedCoverage(filled, none(100), 99)).toBeCloseTo(51 / 100, 5); // played past decoded
  });

  it('counts provisional live buckets as covered', () => {
    const filled = new Uint8Array(100);
    const live = new Uint8Array(100);
    for (let i = 0; i <= 50; i++) live[i] = 1; // played through, live-filled only
    expect(playedCoverage(filled, live, 50)).toBe(1);
    expect(playedCoverage(filled, live, 99)).toBeCloseTo(51 / 100, 5);
  });

  it('is ~0 for a resumed mid-track with nothing captured', () => {
    // played up to bucket 800, but no decoded data anywhere.
    expect(playedCoverage(none(2000), none(2000), 800)).toBe(0);
  });

  it('clamps playedRes to the array bounds', () => {
    const filled = new Uint8Array(10).fill(1);
    expect(playedCoverage(filled, none(10), 999)).toBe(1);
  });
});

describe('extractInitSegment', () => {
  const box = (type: string, payloadSize: number): Uint8Array => {
    const out = new Uint8Array(8 + payloadSize);
    const size = 8 + payloadSize;
    out[0] = (size >>> 24) & 0xff;
    out[1] = (size >>> 16) & 0xff;
    out[2] = (size >>> 8) & 0xff;
    out[3] = size & 0xff;
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    return out;
  };
  const cat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };

  it('returns an init-only chunk whole', () => {
    const init = cat(box('ftyp', 8), box('moov', 16));
    const r = extractInitSegment(init);
    expect(r.complete).toBe(true);
    expect(r.init).toEqual(init);
  });

  it('slices media appended after moov off', () => {
    const init = cat(box('ftyp', 8), box('moov', 16));
    const withMedia = cat(init, box('moof', 32), box('mdat', 64));
    const r = extractInitSegment(withMedia);
    expect(r.complete).toBe(true);
    expect(r.init).toEqual(init); // the media fragment is NOT cached
  });

  it('reports need-more while moov is truncated', () => {
    const full = cat(box('ftyp', 8), box('moov', 16));
    const partial = full.slice(0, full.length - 4); // moov cut short
    expect(extractInitSegment(partial).complete).toBe(false);
    // feeding the rest completes it
    expect(extractInitSegment(full).complete).toBe(true);
  });

  it('carves a complete WebM init and stops before the first Cluster', () => {
    // Build EBML elements with a 1-byte size vint (bodies < 127 bytes).
    const el = (id: number[], body: number[]): number[] => [
      ...id,
      0x80 | body.length,
      ...body,
    ];
    const header = el([0x1a, 0x45, 0xdf, 0xa3], [1, 2, 3, 4]);
    const info = el([0x15, 0x49, 0xa9, 0x66], [0xaa, 0xbb, 0xcc, 0xdd]);
    const tracks = el([0x16, 0x54, 0xae, 0x6b], [0x11, 0x22, 0x33, 0x44]);
    const cluster = el([0x1f, 0x43, 0xb6, 0x75], [0xde, 0xad, 0xbe, 0xef]);
    const segment = el([0x18, 0x53, 0x80, 0x67], [...info, ...tracks]);
    const initOnly = [...header, ...segment];
    const withCluster = [...initOnly, ...cluster];

    const r = extractInitSegment(new Uint8Array(withCluster));
    expect(r.complete).toBe(true);
    // The Cluster (media) is excluded from the cached init.
    expect(Array.from(r.init)).toEqual(initOnly);
  });

  it('keeps an incomplete WebM header pending', () => {
    // EBML header present but no Segment yet.
    const partial = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 1, 2, 3, 4]);
    expect(extractInitSegment(partial).complete).toBe(false);
  });

  it('keeps WebM pending while Tracks is still missing', () => {
    const el = (id: number[], body: number[]): number[] => [
      ...id,
      0x80 | body.length,
      ...body,
    ];
    const header = el([0x1a, 0x45, 0xdf, 0xa3], [1, 2, 3, 4]);
    const info = el([0x15, 0x49, 0xa9, 0x66], [0xaa]);
    const segment = el([0x18, 0x53, 0x80, 0x67], [...info]);
    expect(extractInitSegment(new Uint8Array([...header, ...segment])).complete).toBe(
      false,
    );
  });

  it('completes a WebM init before a trailing Void (spanning an append)', () => {
    const el = (id: number[], body: number[]): number[] => [
      ...id,
      0x80 | body.length,
      ...body,
    ];
    const header = el([0x1a, 0x45, 0xdf, 0xa3], [1, 2, 3, 4]);
    const info = el([0x15, 0x49, 0xa9, 0x66], [0xaa]);
    const tracks = el([0x16, 0x54, 0xae, 0x6b], [0x11]);
    // A Void element (id EC) declared larger than what is present: spans the next append.
    const partialVoid = [0xec, 0x88, 0x01, 0x02];
    const segmentBody = [...info, ...tracks, ...partialVoid];
    const segment = el([0x18, 0x53, 0x80, 0x67], segmentBody);
    const bytes = new Uint8Array([...header, ...segment]);
    const r = extractInitSegment(bytes);
    expect(r.complete).toBe(true);
    // The init ends after Tracks; the 4 partial-Void bytes are NOT cached.
    expect(r.init.length).toBe(bytes.length - partialVoid.length);
    expect(Array.from(r.init)).not.toContain(0xec);
  });

  it('keeps a sub-header prefix pending until it can be classified', () => {
    // Only the 4-byte ftyp size field so far: not a verifiable init.
    const partial = new Uint8Array([0, 0, 0, 24, 0x66, 0x74]);
    const r = extractInitSegment(partial);
    expect(r.complete).toBe(false);
    // fewer than the 4 WebM magic bytes: also pending.
    expect(extractInitSegment(new Uint8Array([0x1a, 0x45])).complete).toBe(
      false,
    );
  });

  it('passes non-init-first streams through whole (previous behaviour)', () => {
    const media = box('moof', 32);
    const r = extractInitSegment(media);
    expect(r.complete).toBe(true);
    expect(r.init).toBe(media);
  });
});

describe('stripDuplicateInit', () => {
  const init = new Uint8Array([1, 2, 3, 4, 5]);

  it('returns the media after a verified duplicate init prefix', () => {
    const media = new Uint8Array([9, 9, 9]);
    const u8 = new Uint8Array([...init, ...media]);
    expect(stripDuplicateInit(u8, init)).toEqual(media);
  });

  it('returns an empty suffix for an exact duplicate (not a replacement)', () => {
    const r = stripDuplicateInit(init, init);
    expect(r).not.toBeNull();
    expect(r!.length).toBe(0);
  });

  it('returns null when the input is shorter than the cached init', () => {
    expect(stripDuplicateInit(new Uint8Array([1, 2, 3]), init)).toBeNull();
  });

  it('returns null when the prefix does not match (different init)', () => {
    const other = new Uint8Array([1, 2, 3, 4, 6, 9, 9]);
    expect(stripDuplicateInit(other, init)).toBeNull();
  });
});

describe('startsAtFragmentBoundary', () => {
  it('recognises fMP4 box headers', () => {
    const moof = new Uint8Array([0, 0, 0, 16, 109, 111, 111, 102, 1, 2]); // 'moof'
    expect(startsAtFragmentBoundary(moof)).toBe(true);
  });

  it('recognises WebM Clusters', () => {
    expect(
      startsAtFragmentBoundary(new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 1])),
    ).toBe(true);
  });

  it('recognises extended-size (64-bit largesize) fragment headers', () => {
    // size == 1 → 8-byte largesize follows the type; 'moof' starts at offset 4.
    const moof64 = new Uint8Array([
      0, 0, 0, 1, 109, 111, 111, 102, 0, 0, 0, 0, 0, 0, 16, 0,
    ]);
    expect(startsAtFragmentBoundary(moof64)).toBe(true);
    // Truncated before the largesize is complete: not yet classifiable.
    expect(startsAtFragmentBoundary(moof64.slice(0, 12))).toBe(false);
  });

  it('does NOT cut at an mdat (it continues the previous moof)', () => {
    // mdat header: media payload of the fragment opened by the preceding moof.
    const mdat = new Uint8Array([0, 0, 0, 16, 109, 100, 97, 116, 1, 2]); // 'mdat'
    expect(startsAtFragmentBoundary(mdat)).toBe(false);
  });

  it('rejects mid-fragment bytes and tiny chunks', () => {
    expect(
      startsAtFragmentBoundary(new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7])),
    ).toBe(false);
    expect(startsAtFragmentBoundary(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('shouldAutoFetchFull (resumed/cached fallback trigger)', () => {
  it('fires when the track has played a while but coverage is near zero', () => {
    expect(shouldAutoFetchFull(0, 5000)).toBe(true);
    expect(shouldAutoFetchFull(0.05, 4000)).toBe(true);
  });

  it('does NOT fire for a normal fresh play (good coverage)', () => {
    expect(shouldAutoFetchFull(0.9, 8000)).toBe(false);
  });

  it('waits out the grace period before firing (avoids racing early buffering)', () => {
    expect(shouldAutoFetchFull(0, 1000)).toBe(false);
    expect(shouldAutoFetchFull(0, 3999)).toBe(false);
    expect(shouldAutoFetchFull(0, 4000)).toBe(true);
  });

  it('respects custom thresholds', () => {
    expect(shouldAutoFetchFull(0.3, 10000, { maxCoverage: 0.5 })).toBe(true);
    expect(shouldAutoFetchFull(0, 2000, { minElapsedMs: 1000 })).toBe(true);
  });
});

const bytes = (...b: number[]) => new Uint8Array(b);

describe('looksLikeInitSegment', () => {
  it('detects an fMP4 ftyp init segment (0x66747970 at offset 4)', () => {
    expect(looksLikeInitSegment(bytes(0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70))).toBe(true);
  });

  it('detects a WebM/EBML init segment (0x1A45DFA3 at offset 0)', () => {
    expect(looksLikeInitSegment(bytes(0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4))).toBe(true);
  });

  it('rejects a media fragment (moof)', () => {
    // "moof" = 0x6d6f6f66 at offset 4 — not an init segment
    expect(looksLikeInitSegment(bytes(0, 0, 0, 40, 0x6d, 0x6f, 0x6f, 0x66))).toBe(false);
  });

  it('rejects too-short buffers', () => {
    expect(looksLikeInitSegment(bytes(0x66, 0x74))).toBe(false);
  });
});

const fill = (n: number, fn: (i: number) => number) => {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = fn(i);
  return a;
};

describe('analyzeBucket', () => {
  it('reports ~0 everywhere for silence', () => {
    const a = analyzeBucket([fill(1000, () => 0)], 0, 1000);
    expect(a.rms).toBeCloseTo(0, 5);
    expect(a.low).toBeCloseTo(0, 5);
    expect(a.high).toBeCloseTo(0, 5);
  });

  it('full-scale DC → rms 1, energy in the low band, ~no highs', () => {
    const a = analyzeBucket([fill(1000, () => 1)], 0, 1000);
    expect(a.rms).toBeCloseTo(1, 3);
    expect(a.low).toBeGreaterThan(0.5);
    expect(a.high).toBeLessThan(0.05);
    expect(a.low).toBeGreaterThan(a.high);
  });

  it('Nyquist (alternating ±1) → energy in the high band', () => {
    const a = analyzeBucket([fill(1000, (i) => (i % 2 === 0 ? 1 : -1))], 0, 1000);
    expect(a.rms).toBeCloseTo(1, 3);
    expect(a.high).toBeGreaterThan(a.low);
    expect(a.high).toBeGreaterThan(a.mid);
    expect(a.high).toBeGreaterThan(0.8);
  });

  it('includes a one-sided (panned) signal in the band energies', () => {
    // Silence on the left, high-frequency content only on the right. Reading channel 0
    // alone would report zero band energy and draw a black column for audible audio.
    const left = fill(1000, () => 0);
    const right = fill(1000, (i) => (i % 2 === 0 ? 1 : -1));
    const a = analyzeBucket([left, right], 0, 1000);
    expect(a.rms).toBeGreaterThan(0.5);
    expect(a.high).toBeGreaterThan(0.3);
  });

  it('a ~1 kHz tone lands mostly in the MID band (not low or high)', () => {
    // sr=44.1k so a 1 kHz sine sits between the ~210 Hz and ~1.5 kHz cutoffs.
    const sr = 44100;
    const tone = fill(4000, (i) => Math.sin((2 * Math.PI * 1000 * i) / sr));
    const a = analyzeBucket([tone], 0, 4000);
    expect(a.mid).toBeGreaterThan(a.low);    expect(a.mid).toBeGreaterThan(a.high);
  });

  it('averages RMS across two channels', () => {
    const loud = fill(100, () => 1);
    const quiet = fill(100, () => 0);
    // mean square = (1 + 0) / 2 = 0.5 → rms = sqrt(0.5)
    expect(analyzeBucket([loud, quiet], 0, 100).rms).toBeCloseTo(Math.SQRT1_2, 3);
  });
});

describe('bandColor (Rekordbox RGB mapping: low→red, mid→green, high→blue)', () => {
  it('pure bass → red', () => {
    expect(bandColor(1, 0, 0)).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('pure highs → blue', () => {
    expect(bandColor(0, 0, 1)).toEqual({ r: 0, g: 0, b: 255 });
  });

  it('pure mids → green', () => {
    expect(bandColor(0, 1, 0)).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('balanced bands → white', () => {
    expect(bandColor(0.5, 0.5, 0.5)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('the dominant band hits 255 and weaker bands are attenuated by the contrast curve', () => {
    const c = bandColor(1, 0.5, 0);
    expect(c.r).toBe(255);
    expect(c.b).toBe(0);
    expect(c.g).toBeGreaterThan(0);
    expect(c.g).toBeLessThan(120); // 255 * 0.5^1.6 ≈ 84
  });

  it('never divides by zero for an all-silent slice', () => {
    expect(bandColor(0, 0, 0)).toEqual({ r: 0, g: 0, b: 0 });
  });
});
