import { describe, expect, it } from 'vitest';

import {
  continuationStart,
  followState,
  isFullyDecoded,
  pickRunToDecode,
  planAppend,
  shouldFreeChunks,
  type RunLike,
} from './lib';

// Progressive "run" bookkeeping: how appended chunks are routed, which run is decoded next,
// where a continuation run starts, and when a sealed run's chunks may be freed.

const run = (over: Partial<RunLike> = {}): RunLike => ({
  bytes: 0,
  lastDecodedBytes: 0,
  chunks: [1],
  ...over,
});

describe('planAppend', () => {
  it('drops a repeated init segment', () => {
    expect(planAppend({ bytes: 500, leadsWithInit: true }, true, 1000)).toBe(
      'drop',
    );
  });

  it('appends a first init segment, and ordinary media chunks', () => {
    expect(planAppend({ bytes: 0, leadsWithInit: false }, true, 1000)).toBe(
      'append',
    );
    expect(planAppend({ bytes: 500, leadsWithInit: true }, false, 1000)).toBe(
      'append',
    );
  });

  it('rolls over once the run has reached the cap', () => {
    expect(planAppend({ bytes: 999, leadsWithInit: true }, false, 1000)).toBe(
      'append',
    );
    expect(planAppend({ bytes: 1000, leadsWithInit: true }, false, 1000)).toBe(
      'rollover',
    );
    expect(planAppend({ bytes: 5000, leadsWithInit: true }, false, 1000)).toBe(
      'rollover',
    );
  });

  it('drops a repeated init even when the run is at the cap', () => {
    expect(planAppend({ bytes: 5000, leadsWithInit: true }, true, 1000)).toBe(
      'drop',
    );
  });
});

describe('isFullyDecoded', () => {
  it('needs a start, a decoded duration, and every byte covered', () => {
    expect(isFullyDecoded(run({ bytes: 10 }))).toBe(false);
    expect(isFullyDecoded(run({ bytes: 10, start: 0, decodedSec: 5 }))).toBe(
      false,
    );
    expect(
      isFullyDecoded(
        run({ bytes: 10, start: 0, decodedSec: 5, decodedBytes: 8 }),
      ),
    ).toBe(false);
    expect(
      isFullyDecoded(
        run({ bytes: 10, start: 0, decodedSec: 5, decodedBytes: 10 }),
      ),
    ).toBe(true);
  });
});

describe('followState / continuationStart', () => {
  const done = run({ bytes: 10, start: 30, decodedSec: 12, decodedBytes: 10 });

  it('a run that continues nothing is always ready', () => {
    expect(followState(run())).toBe('ready');
  });

  it('waits for a predecessor that is not completely decoded', () => {
    expect(followState(run({ follows: run({ bytes: 10 }) }))).toBe('wait');
    expect(followState(run({ follows: { ...done, decodedBytes: 6 } }))).toBe(
      'wait',
    );
  });

  it('is ready once the predecessor is completely decoded', () => {
    expect(followState(run({ follows: done }))).toBe('ready');
  });

  it('is dropped when the predecessor failed', () => {
    expect(followState(run({ follows: run({ failed: true }) }))).toBe('drop');
  });

  it('is dropped when any earlier run in the chain failed', () => {
    const a = run({ failed: true });
    const b = run({ follows: a });
    const c = run({ follows: b });
    expect(followState(b)).toBe('drop');
    expect(followState(c)).toBe('drop'); // b has not been marked yet, a has
  });

  it('keeps a continuation waiting while a failed predecessor still has bytes to retry', () => {
    const failed = run({ bytes: 1200, lastDecodedBytes: 1000, failed: true });
    expect(followState(run({ follows: failed }))).toBe('wait');
    failed.lastDecodedBytes = 1200; // nothing left to retry → the failure is terminal
    expect(followState(run({ follows: failed }))).toBe('drop');
  });

  it('waits while a retry is still in flight, even with nothing new to decode', () => {
    // A decode covering every byte is in flight for the predecessor (decoding set):
    // the earlier failure must not drop the dependent before the retry settles.
    const retrying = run({
      bytes: 1200,
      lastDecodedBytes: 1200,
      failed: true,
      decoding: 7,
    });
    expect(followState(run({ follows: retrying }))).toBe('wait');
    retrying.decoding = undefined; // settled without new bytes → terminal failure
    expect(followState(run({ follows: retrying }))).toBe('drop');
  });

  it('starts a continuation where its predecessor ends', () => {
    expect(continuationStart(done)).toBe(42);
    expect(continuationStart(run())).toBe(0);
  });
});

describe('shouldFreeChunks', () => {
  it('never frees the run still being appended to', () => {
    expect(
      shouldFreeChunks(true, run({ bytes: 10, lastDecodedBytes: 10 })),
    ).toBe(false);
  });

  it('frees a sealed run once the decode covered every byte', () => {
    expect(
      shouldFreeChunks(false, run({ bytes: 10, lastDecodedBytes: 10 })),
    ).toBe(true);
  });

  it('keeps a sealed run that received audio during its last decode', () => {
    expect(
      shouldFreeChunks(false, run({ bytes: 14, lastDecodedBytes: 10 })),
    ).toBe(false);
  });
});

describe('pickRunToDecode', () => {
  const opts = { minDecodeBytes: 100, minNewBytes: 500 };

  it('ignores a growing run until it has enough new data', () => {
    const cur = run({ bytes: 499 });
    expect(pickRunToDecode([cur], cur, opts).pick).toBeNull();
    const ready = run({ bytes: 500 });
    expect(pickRunToDecode([ready], ready, opts).pick?.run).toBe(ready);
  });

  it('ignores a growing run below the decode threshold', () => {
    const freed = run({ bytes: 900, chunks: [] }); // nothing to decode
    const tiny = run({ bytes: 50 }); // still growing
    expect(pickRunToDecode([freed, tiny], tiny, opts).pick).toBeNull();
  });

  it('decodes a small SEALED run (it can never grow)', () => {
    // A sealed run below minDecodeBytes must still decode, or its continuation would wait
    // forever (it cannot gain bytes to cross the threshold).
    const smallSealed = run({ bytes: 40 });
    expect(pickRunToDecode([smallSealed], null, opts).pick?.run).toBe(smallSealed);
  });

  it('decodes any undecoded tail of a sealed run, however small', () => {
    const sealed = run({ bytes: 700, lastDecodedBytes: 699 });
    expect(pickRunToDecode([sealed], null, opts).pick?.run).toBe(sealed);
  });

  it('prefers a sealed run over a larger growing one', () => {
    const sealed = run({ bytes: 700, lastDecodedBytes: 600 });
    const cur = run({ bytes: 9000 });
    const res = pickRunToDecode([cur, sealed], cur, opts);
    expect(res.pick?.run).toBe(sealed);
    expect(res.pick?.index).toBe(1);
  });

  it('makes a continuation wait, then picks it once its predecessor is decoded', () => {
    const prev = run({
      bytes: 700,
      lastDecodedBytes: 700,
      start: 0,
      decodedSec: 40,
    });
    const next = run({ bytes: 700, follows: prev });
    expect(pickRunToDecode([prev, next], null, opts).pick).toBeNull();
    prev.decodedBytes = 700;
    expect(pickRunToDecode([prev, next], null, opts).pick?.run).toBe(next);
  });

  it('reports a continuation whose predecessor failed as dropped, not picked', () => {
    // A failed decode leaves lastDecodedBytes at the byte count it attempted.
    const prev = run({ bytes: 700, lastDecodedBytes: 700, failed: true });
    const next = run({ bytes: 700, follows: prev });
    const res = pickRunToDecode([prev, next], null, opts);
    expect(res.pick).toBeNull();
    expect(res.dropped).toEqual([next]);
  });

  it('retries a failed sealed predecessor that gained bytes, without dropping its continuation', () => {
    const prev = run({ bytes: 1200, lastDecodedBytes: 1000, failed: true });
    const next = run({ bytes: 700, follows: prev });
    const res = pickRunToDecode([prev, next], null, opts);
    expect(res.pick?.run).toBe(prev);
    expect(res.dropped).toEqual([]);
  });
});

describe('progressive capture of a long track (simulated)', () => {
  // Mirrors how index.ts drives the helpers: appended chunks are routed by planAppend,
  // decodes are chosen by pickRunToDecode, and each decode records its start/length and may
  // free the run's chunks. Sizes are scaled down; one second of audio is BPS bytes.
  const BPS = 16000;
  const INIT = 1000;
  const MAX_RUN = 1_000_000; // ~62 s per run
  const OPTS = { minDecodeBytes: 50_000, minNewBytes: 120_000 };

  type Chunk = { size: number; init: boolean };
  interface SimRun extends RunLike {
    chunks: Chunk[];
    seekTarget: number;
    follows?: SimRun;
  }
  type Snapshot = { run: SimRun; bytes: number };

  const makeRun = (seekTarget: number, follows?: SimRun): SimRun => ({
    seekTarget,
    chunks: [{ size: INIT, init: true }],
    bytes: INIT,
    lastDecodedBytes: 0,
    follows,
  });

  const makeSim = () => {
    const runs: SimRun[] = [];
    const state: { current: SimRun | null } = { current: null };

    const startRun = (seekTarget: number) => {
      state.current = makeRun(seekTarget);
      runs.push(state.current);
    };

    const append = (seconds: number) => {
      if (!state.current) startRun(0);
      const cur = state.current as SimRun;
      const action = planAppend(
        { bytes: cur.bytes, leadsWithInit: cur.chunks[0]?.init ?? false },
        false,
        MAX_RUN,
      );
      let target = cur;
      if (action === 'rollover') {
        target = makeRun(cur.seekTarget, cur);
        runs.push(target);
        state.current = target;
      }
      const size = seconds * BPS;
      target.chunks.push({ size, init: false });
      target.bytes += size;
    };

    // A decode in two phases, so audio can arrive while it is "in flight".
    const beginDecode = (): Snapshot | null => {
      const { pick, dropped } = pickRunToDecode(runs, state.current, OPTS);
      for (const lost of dropped) {
        lost.failed = true;
        lost.chunks = [];
      }
      if (!pick) return null;
      const snap = { run: pick.run, bytes: pick.run.bytes };
      pick.run.lastDecodedBytes = pick.run.bytes;
      return snap;
    };

    const finishDecode = (snap: Snapshot, fail = false) => {
      const r = snap.run;
      if (fail) {
        r.failed = true;
      } else {
        // A continuation is never placed before its predecessor is completely decoded.
        if (r.follows) expect(isFullyDecoded(r.follows)).toBe(true);
        r.start ??= r.follows ? continuationStart(r.follows) : r.seekTarget;
        r.decodedSec = (snap.bytes - INIT) / BPS;
        r.decodedBytes = snap.bytes;
        r.failed = false;
      }
      if (shouldFreeChunks(r === state.current, r)) r.chunks = [];
    };

    const decodeOnce = (fail?: (r: SimRun) => boolean) => {
      const snap = beginDecode();
      if (!snap) return false;
      finishDecode(snap, fail?.(snap.run) ?? false);
      return true;
    };

    const drain = (fail?: (r: SimRun) => boolean) => {
      for (let i = 0; i < 1000; i++) {
        if (!decodeOnce(fail)) return;
      }
    };

    return {
      runs,
      state,
      append,
      startRun,
      beginDecode,
      finishDecode,
      decodeOnce,
      drain,
    };
  };

  const coveredTo = (runs: SimRun[]) => {
    const last = runs.filter((r) => isFullyDecoded(r)).at(-1);
    return last ? (last.start ?? 0) + (last.decodedSec ?? 0) : 0;
  };

  it('keeps capturing past the cap and places every run contiguously', () => {
    const sim = makeSim();
    for (let t = 0; t < 600; t += 10) {
      sim.append(10);
      sim.decodeOnce(); // the decoder keeps up as audio arrives
    }
    sim.drain();

    expect(sim.runs.length).toBeGreaterThanOrEqual(9); // ~62 s per run over 600 s
    expect(sim.runs[0].start).toBe(0);
    for (const r of sim.runs.slice(1)) {
      const prev = r.follows as SimRun;
      expect(r.start).toBeCloseTo(
        (prev.start ?? 0) + (prev.decodedSec ?? 0),
        6,
      );
    }
    expect(sim.runs.every((r) => isFullyDecoded(r))).toBe(true);
    expect(coveredTo(sim.runs)).toBeCloseTo(600, 3); // nothing past the cap was dropped
  });

  it('frees every sealed run once decoded, keeping memory bounded', () => {
    const sim = makeSim();
    for (let t = 0; t < 600; t += 10) sim.append(10);
    sim.drain();
    const held = sim.runs.filter((r) => r.chunks.length > 0);
    expect(held).toEqual([sim.state.current]); // only the run still being appended to
  });

  it('still chains correctly when the decoder lags far behind the appends', () => {
    const sim = makeSim();
    for (let t = 0; t < 600; t += 10) sim.append(10); // no decode at all until the end
    sim.drain();
    expect(sim.runs.every((r) => isFullyDecoded(r))).toBe(true);
    expect(coveredTo(sim.runs)).toBeCloseTo(600, 3);
  });

  it('drops the continuations of a run that failed to decode, and keeps the earlier audio', () => {
    const sim = makeSim();
    for (let t = 0; t < 400; t += 10) sim.append(10);
    sim.drain((r) => r === sim.runs[2]);

    expect(isFullyDecoded(sim.runs[0])).toBe(true);
    expect(isFullyDecoded(sim.runs[1])).toBe(true);
    for (const r of sim.runs.slice(2)) {
      expect(r.failed).toBe(true);
      expect(r.chunks).toEqual([]); // released rather than left waiting forever
    }
  });

  it('decodes audio that arrived during a decode before releasing the run', () => {
    const sim = makeSim();
    for (let t = 0; t < 120; t += 10) sim.append(10);
    sim.drain(); // the first run (~62 s) rolled over and decoded; the second is still growing
    const growing = sim.state.current as SimRun;
    sim.append(10); // enough new audio for the growing run to be decoded again

    const snap = sim.beginDecode(); // snapshot of the growing run...
    expect(snap?.run).toBe(growing);
    sim.append(30); // ...then more audio arrives while it decodes
    sim.startRun(400); // ...and a seek seals it before the decode finishes
    sim.finishDecode(snap as Snapshot);

    expect(growing.chunks.length).toBeGreaterThan(0); // not freed: the tail is undecoded
    expect(isFullyDecoded(growing)).toBe(false);
    sim.drain();
    expect(isFullyDecoded(growing)).toBe(true); // the tail got its final decode
    expect(growing.chunks).toEqual([]); // and only then was the memory released
  });

  it('keeps a continuation while its failed predecessor is retried, then places it', () => {
    const sim = makeSim();
    for (let t = 0; t < 60; t += 10) sim.append(10); // 6 chunks: still under the cap
    const snap = sim.beginDecode(); // a decode is in flight on the growing run...
    sim.append(10); // ...more audio arrives (still under the cap)...
    sim.append(10); // ...and the run is now over it, so this append rolls over
    const [first, second] = sim.runs;
    expect(sim.runs).toHaveLength(2);
    sim.finishDecode(snap as Snapshot, true); // the in-flight decode fails

    expect(first.failed).toBe(true);
    expect(followState(second)).toBe('wait'); // a retry is still possible → not dropped
    expect(second.chunks.length).toBeGreaterThan(0);

    sim.drain(); // the retry succeeds, then the continuation is placed
    expect(isFullyDecoded(first)).toBe(true);
    expect(isFullyDecoded(second)).toBe(true);
    expect(second.start).toBeCloseTo(
      (first.start ?? 0) + (first.decodedSec ?? 0),
      6,
    );
    expect(coveredTo(sim.runs)).toBeCloseTo(80, 3); // nothing lost
  });
});
