/**
 * Consolidate sound effects (the "shuffle").
 *
 * Three separate bugs made this play late, play twice, or stop playing at all:
 *
 *  1. **A fresh `AudioContext` per burst.** Chrome caps a document at ~6 live
 *     contexts and none of these were ever closed, so after a handful of
 *     consolidates the constructor threw and the `catch` swallowed it — silence
 *     for the rest of the session.
 *  2. **Scheduling against a suspended context.** A context created outside a
 *     user gesture starts `suspended`, where `currentTime` is frozen at 0. The
 *     old code called `void ctx.resume()` and immediately scheduled everything
 *     relative to that frozen clock. Whenever the context actually resumed —
 *     which could be the next click, seconds or minutes later — the entire
 *     backlog fired at once. That is exactly the "doesn't play, then comes
 *     through a long time later" symptom.
 *  3. **An unbounded schedule.** Chimes used a flat 0.04 s gap capped at 2000
 *     notes: consolidating a large board queued eighty seconds of audio that
 *     kept trickling out long after the grid had settled.
 *
 * The fix is one shared context, resumed *before* the clock is read, and a
 * schedule compressed to fit a fixed wall-clock budget. Synthesis is unchanged,
 * so the sounds themselves are identical.
 */

/** No burst may span longer than this. Past ~1.5 s the cascade stops reading as
 *  feedback for the action and starts reading as a stuck sound. */
const MAX_BURST_SECONDS = 1.5;

/** Hard ceiling on scheduled voices per burst. Beyond this they overlap into
 *  noise anyway, and each one is a handful of Web Audio nodes. */
const MAX_VOICES = 96;

export type ConsolidateSoundStyle = 'off' | 'solitaire' | 'chimes' | (string & {});

let ctx: AudioContext | null = null;

/** Lazily create the single shared context. Returns null when Web Audio is
 *  unavailable (older WebViews, audio device missing). */
function getContext(): AudioContext | null {
  if (ctx && ctx.state !== 'closed') return ctx;
  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Resume the shared context and hand back a clock we can safely schedule on.
 *
 * Returns null when the context can't be resumed — typically because no user
 * gesture has happened yet. Dropping the burst is the right call there: the
 * alternative is queueing it against a frozen clock so it ambushes the user
 * later.
 */
async function readyContext(): Promise<AudioContext | null> {
  const c = getContext();
  if (!c) return null;
  if (c.state === 'suspended') {
    try {
      await c.resume();
    } catch {
      return null;
    }
  }
  return c.state === 'running' ? c : null;
}

/**
 * Build the per-voice start offsets for a burst.
 *
 * `accelerate` starts slow (0.25 s) and eases into a fast run; otherwise the
 * spacing is the uniform fast tick of a card shuffle. Whatever shape comes out,
 * the whole thing is then scaled to fit {@link MAX_BURST_SECONDS} — compressing
 * rather than truncating, so a big consolidate still sounds like a big one.
 */
function buildOffsets(count: number, accelerate: boolean, uniformGap: number): number[] {
  const startGap = accelerate ? 0.25 : uniformGap;
  const endGap = accelerate
    ? (count > 1 ? Math.max(0.005, 10 / (count * count)) : startGap)
    : uniformGap;

  const offsets: number[] = [];
  let elapsed = 0;
  for (let i = 0; i < count; i++) {
    offsets.push(elapsed);
    const progress = count > 1 ? i / (count - 1) : 0;
    // Ease-in: the gap shrinks from startGap → endGap as progress² ramps up.
    elapsed += startGap - (startGap - endGap) * (progress ** 2);
  }

  const span = offsets[offsets.length - 1] ?? 0;
  if (span > MAX_BURST_SECONDS) {
    const scale = MAX_BURST_SECONDS / span;
    for (let i = 0; i < offsets.length; i++) offsets[i] *= scale;
  }
  return offsets;
}

/** One bell voice: fundamental + two inharmonic partials, plucked envelope. */
function chime(c: AudioContext, t: number, freq: number): void {
  const osc1 = c.createOscillator(); osc1.type = 'sine'; osc1.frequency.value = freq;
  const osc2 = c.createOscillator(); osc2.type = 'triangle'; osc2.frequency.value = freq * 3;
  const osc3 = c.createOscillator(); osc3.type = 'sine'; osc3.frequency.value = freq * 5.2;
  const g1 = c.createGain(); const g2 = c.createGain(); const g3 = c.createGain();
  g1.gain.setValueAtTime(0.045, t); g1.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  g2.gain.setValueAtTime(0.011, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.21);
  g3.gain.setValueAtTime(0.004, t); g3.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  osc1.connect(g1).connect(c.destination);
  osc2.connect(g2).connect(c.destination);
  osc3.connect(g3).connect(c.destination);
  osc1.start(t); osc1.stop(t + 0.35);
  osc2.start(t); osc2.stop(t + 0.21);
  osc3.start(t); osc3.stop(t + 0.1);
}

/** One card-swoosh: short filtered noise burst with a quick in/out envelope. */
function swoosh(c: AudioContext, t: number): void {
  const bufLen = Math.floor(c.sampleRate * 0.08);
  const buf = c.createBuffer(1, bufLen, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let j = 0; j < bufLen; j++) data[j] = Math.random() * 2 - 1;
  const noise = c.createBufferSource();
  noise.buffer = buf;
  // Highpass to keep it airy, not boomy; bandpass for body.
  const hp = c.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 2000; hp.Q.value = 0.5;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 4000 + Math.random() * 1000; bp.Q.value = 0.7;
  const env = c.createGain();
  env.gain.setValueAtTime(0.001, t);
  env.gain.linearRampToValueAtTime(0.1125, t + 0.015);
  env.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  noise.connect(hp).connect(bp).connect(env).connect(c.destination);
  noise.start(t); noise.stop(t + 0.08);
}

const CHIME_SCALE = [523, 587, 659, 784, 880, 1047, 1175, 1319, 1568, 1760];

/** Wall-clock time (ms) the currently scheduled burst finishes. Used to drop a
 *  second burst that would land on top of the first — back-to-back consolidates
 *  otherwise stack into a smear. */
let burstEndsAt = 0;

/**
 * Play the consolidate cascade for `blanks` removed notes.
 *
 * Async only because the context may need resuming first; callers fire and
 * forget. Never throws.
 */
export async function playConsolidateSound(
  style: ConsolidateSoundStyle,
  blanks: number,
  accelerate: boolean,
): Promise<void> {
  if (style === 'off' || blanks <= 0) return;
  // Nothing to hear in a background tab, and scheduling there just queues audio
  // that fires when the user comes back.
  if (typeof document !== 'undefined' && document.hidden) return;
  if (Date.now() < burstEndsAt) return;

  const c = await readyContext();
  if (!c) return;

  // Solitaire is one swoosh per three notes; chimes are one per note. Both are
  // capped so a huge consolidate doesn't allocate thousands of nodes.
  const voices = style === 'chimes'
    ? Math.min(blanks, MAX_VOICES)
    : Math.min(Math.max(1, Math.ceil(blanks / 3)), MAX_VOICES);
  const offsets = buildOffsets(voices, accelerate, 0.04);

  const start = c.currentTime;
  for (let i = 0; i < voices; i++) {
    const t = start + offsets[i];
    if (style === 'chimes') {
      const progress = voices > 1 ? i / (voices - 1) : 0;
      const noteIdx = Math.floor(progress * (CHIME_SCALE.length - 1));
      chime(c, t, CHIME_SCALE[noteIdx] + (Math.random() - 0.5) * 10);
    } else {
      swoosh(c, t);
    }
  }

  const span = offsets[offsets.length - 1] ?? 0;
  burstEndsAt = Date.now() + span * 1000;
}

/** Preview used by the sound picker: three voices, starting slow. */
export async function previewConsolidateSound(style: ConsolidateSoundStyle): Promise<void> {
  if (style === 'off') return;
  const c = await readyContext();
  if (!c) return;
  // Gaps: 0.25 s then 0.15 s — starts slow, gets faster, like a real cascade.
  const gaps = [0, 0.25, 0.4];
  const scale = [523, 659, 880];
  for (let i = 0; i < 3; i++) {
    const t = c.currentTime + gaps[i];
    if (style === 'chimes') chime(c, t, scale[i]);
    else swoosh(c, t);
  }
}

/** Test seam — resets the module singletons between cases. */
export function __resetConsolidateSoundForTests(): void {
  ctx = null;
  burstEndsAt = 0;
}

/** Exposed for tests: the offset schedule is the part with real logic in it. */
export const __testables = { buildOffsets, MAX_BURST_SECONDS, MAX_VOICES };
