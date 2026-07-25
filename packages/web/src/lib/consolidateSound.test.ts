/**
 * Consolidate-sound scheduling.
 *
 * The regression this guards is the one users actually reported: a big
 * consolidate used to queue a minute-plus of audio that kept arriving long
 * after the action, and a context created outside a user gesture queued the
 * whole burst against a frozen clock so it ambushed them later.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  playConsolidateSound,
  __resetConsolidateSoundForTests,
  __testables,
} from './consolidateSound';

const { buildOffsets, MAX_BURST_SECONDS, MAX_VOICES } = __testables;

describe('buildOffsets', () => {
  it('starts at zero and increases monotonically', () => {
    const offsets = buildOffsets(10, false, 0.04);
    expect(offsets[0]).toBe(0);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    }
  });

  it('never spans longer than the burst budget, however many voices', () => {
    for (const count of [1, 5, 50, MAX_VOICES, 2000]) {
      for (const accelerate of [false, true]) {
        const offsets = buildOffsets(count, accelerate, 0.04);
        expect(offsets[offsets.length - 1]).toBeLessThanOrEqual(MAX_BURST_SECONDS + 1e-9);
      }
    }
  });

  it('compresses rather than truncates — an over-budget burst keeps every voice', () => {
    // 2000 voices at a 0.04 s tick would be 80 seconds unscaled.
    const offsets = buildOffsets(2000, false, 0.04);
    expect(offsets).toHaveLength(2000);
    expect(offsets[offsets.length - 1]).toBeCloseTo(MAX_BURST_SECONDS, 6);
  });

  it('starts slow in accelerate mode and speeds up', () => {
    const offsets = buildOffsets(20, true, 0.04);
    const firstGap = offsets[1] - offsets[0];
    const lastGap = offsets[offsets.length - 1] - offsets[offsets.length - 2];
    expect(firstGap).toBeGreaterThan(lastGap);
  });

  it('handles a single voice without producing NaN', () => {
    expect(buildOffsets(1, true, 0.04)).toEqual([0]);
    expect(buildOffsets(0, false, 0.04)).toEqual([]);
  });
});

// ─── playConsolidateSound ────────────────────────────────────────────────────

/** Minimal Web Audio stand-in that records how many voices were started. */
function installFakeAudio(initialState: AudioContextState) {
  const started: number[] = [];
  let state = initialState;
  const node = () => ({
    connect: (next: unknown) => next,
    frequency: { value: 0 },
    Q: { value: 0 },
    gain: {
      setValueAtTime: () => {},
      linearRampToValueAtTime: () => {},
      exponentialRampToValueAtTime: () => {},
    },
    type: '',
    buffer: null as unknown,
    start: (t: number) => { started.push(t); },
    stop: () => {},
  });
  const ctor = vi.fn(() => ({
    get state() { return state; },
    currentTime: 0,
    sampleRate: 48000,
    resume: vi.fn(async () => { state = 'running'; }),
    createOscillator: node,
    createGain: node,
    createBiquadFilter: node,
    createBufferSource: node,
    createBuffer: () => ({ getChannelData: () => new Float32Array(16) }),
    destination: {},
  }));
  vi.stubGlobal('AudioContext', ctor);
  return { started, ctor };
}

describe('playConsolidateSound', () => {
  beforeEach(() => {
    __resetConsolidateSoundForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resumes a suspended context before scheduling anything', async () => {
    const { started } = installFakeAudio('suspended');
    await playConsolidateSound('chimes', 4, false);
    // Scheduling only happens once the clock is actually running; had it gone
    // ahead while suspended, these voices would fire whenever the user next
    // clicked something.
    expect(started.length).toBeGreaterThan(0);
  });

  it('reuses one AudioContext across bursts instead of leaking one each time', async () => {
    const { ctor } = installFakeAudio('running');
    // Each of these is a 1–3 voice burst, short enough that the overlap guard
    // has already expired by the next call.
    await playConsolidateSound('solitaire', 3, false);
    await playConsolidateSound('solitaire', 3, false);
    await playConsolidateSound('chimes', 3, false);
    expect(ctor).toHaveBeenCalledTimes(1);
  });

  it('caps voices for a huge consolidate', async () => {
    const { started } = installFakeAudio('running');
    await playConsolidateSound('solitaire', 100_000, false);
    // Solitaire is one swoosh per 3 notes; each swoosh starts exactly one node.
    expect(started.length).toBeLessThanOrEqual(MAX_VOICES);
    expect(started.length).toBeGreaterThan(0);
    expect(Math.max(...started)).toBeLessThanOrEqual(MAX_BURST_SECONDS + 1e-9);
  });

  it('does nothing when the style is off or there is nothing to consolidate', async () => {
    const { started } = installFakeAudio('running');
    await playConsolidateSound('off', 50, false);
    await playConsolidateSound('chimes', 0, false);
    expect(started).toHaveLength(0);
  });

  it('drops a second burst that would land on top of the first', async () => {
    const { started } = installFakeAudio('running');
    await playConsolidateSound('chimes', 40, false);
    const afterFirst = started.length;
    await playConsolidateSound('chimes', 40, false);
    expect(started.length).toBe(afterFirst);
  });
});
