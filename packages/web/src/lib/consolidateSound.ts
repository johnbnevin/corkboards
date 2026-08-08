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

import { isTauri } from '@/lib/tauri';

/** No burst may span longer than this. Past ~1.5 s the cascade stops reading as
 *  feedback for the action and starts reading as a stuck sound. */
const MAX_BURST_SECONDS = 1.5;

/** Hard ceiling on scheduled voices per burst. Beyond this they overlap into
 *  noise anyway, and each one is a handful of Web Audio nodes. */
const MAX_VOICES = 96;

/** How long to wait for a suspended context to resume before giving up.
 *
 *  Was 250 ms, which is comfortable when resume() is a state flip but not when
 *  it has to reopen the output device: the idle-suspend below releases the
 *  device between bursts, and on Linux (WebKitGTK → PipeWire/PulseAudio) the
 *  reopen routinely takes several hundred ms. Every burst that lost that race
 *  was silently dropped — the desktop's "shuffle sound sometimes doesn't play".
 *  1s keeps the never-unlocked case bounded while giving a real device reopen
 *  room to finish; MAX_SCHEDULING_LAG_MS still guarantees nothing plays late
 *  enough to feel detached from its cause. */
const RESUME_TIMEOUT_MS = 1000;

/** A burst that waited longer than this is no longer feedback for the action
 *  that caused it, so it is dropped rather than played late. */
const MAX_SCHEDULING_LAG_MS = 2000;

/** Lead time added when the context had to be woken for this burst.
 *
 *  PipeWire treats the WebKit stream as live (`stream.is-live = true`): samples
 *  the sink can't consume yet are DROPPED, not buffered. An ALSA sink starts
 *  consuming near-instantly, but a Bluetooth A2DP sink takes hundreds of ms to
 *  spin up from suspend — a sub-second burst scheduled at `currentTime` right
 *  after resume() plays partly or entirely into that drop window. Measured on
 *  the desktop build over BT: half a second of truncated audio, or nothing at
 *  all, while the very same code was clean through the wired sink. Scheduling
 *  the first voice slightly in the future costs nothing audible and gives a
 *  slow sink time to actually be listening.
 *
 *  Was 0.3 s, which covered the common case but still lost the head of the
 *  burst on slower BT sinks whose A2DP wake runs longer — the residual
 *  "inconsistent over Bluetooth" report. 0.45 s is still well inside what
 *  reads as immediate feedback. */
const WAKE_LEAD_SECONDS = 0.45;

/** How long after the last scheduled voice the output sink is assumed to still
 *  be hot.
 *
 *  The wake lead used to be applied only when the AudioContext itself had to
 *  be resumed. But SUSPEND_IDLE_GRACE_SECONDS keeps the context `running` for
 *  30 s after a burst, and PipeWire suspends an idle Bluetooth sink much
 *  sooner than that — so a burst arriving, say, 15 s after the previous one
 *  found a running context, took the no-lead path, and played its head into
 *  the sink's spin-up drop window anyway. That gap is why the sound stayed
 *  inconsistent over BT after the 0.8.2 fix. PipeWire's default node suspend
 *  is 5 s of idle; assume cold after 4 s to stay on the safe side.
 *
 *  Desktop (Tauri/WebKitGTK) only: that is where the drop was measured, and
 *  padding every >4s-apart burst in ordinary browsers would trade a verified
 *  desktop bug for a universal 0.45 s lag nobody reported. */
const SINK_HOT_WINDOW_MS = 4000;

/** How long the context stays running after the last voice before the
 *  idle-suspend kicks in.
 *
 *  This used to be effectively the voice tail (~0.4 s), which meant EVERY burst
 *  suspended the context — and over Bluetooth, every next burst then paid the
 *  full sink spin-up again (see WAKE_LEAD_SECONDS), turning back-to-back sounds
 *  into a glitch lottery. Thirty seconds keeps the sink hot across a run of
 *  consolidates while still putting the render thread to sleep once the user
 *  has actually gone quiet, which is all the CPU-drain fix ever needed. */
const SUSPEND_IDLE_GRACE_SECONDS = 30;

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
 * Unlock the audio context on the first real user gesture.
 *
 * Auto-consolidate fires from a TIMER, and a timer callback is not a user
 * gesture — WebKit (which the desktop build runs on) will not resume a
 * suspended AudioContext outside one, so `readyContext()` returned null and the
 * burst was dropped. Every consolidate was silent for anyone using the
 * auto-consolidate toggle, which is most of them.
 *
 * Having a gesture happen *earlier* in the session isn't enough either: the
 * context has to be resumed DURING one. So resume on pointer/key events, and
 * from then on the context is `running` and timer-driven bursts schedule
 * normally.
 *
 * The listeners are PERSISTENT, not `once`. The idle-suspend in
 * `scheduleSuspend` puts the context back to `suspended` after every burst,
 * and engines that gate resume() on a gesture (WebKitGTK in particular) then
 * need the NEXT gesture to unlock it again — with `once` listeners already
 * consumed, every later timer-driven burst raced its own resume and the sound
 * went permanently inconsistent. A no-op state check per pointerdown is free.
 */
let unlockArmed = false;
function armAudioUnlock(): void {
  if (unlockArmed || typeof window === 'undefined') return;
  unlockArmed = true;
  const unlock = () => {
    const c = getContext();
    if (c && c.state === 'suspended') {
      void c.resume().catch(() => {});
      // Re-suspend (after the idle grace) if no burst claims the context.
      // Without this, the persistent listener resurrects the render thread on
      // EVERY click and nothing ever puts it back to sleep — the exact
      // always-running CPU drain the idle-suspend exists to prevent. A burst
      // arriving within the window cancels/reschedules this via its own
      // scheduleSuspend call.
      scheduleSuspend(5);
    }
  };
  for (const evt of ['pointerdown', 'keydown', 'touchstart'] as const) {
    window.addEventListener(evt, unlock, { passive: true, capture: true });
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
async function readyContext(): Promise<{ c: AudioContext; wakeLead: number } | null> {
  const c = getContext();
  if (!c) return null;
  let wakeLead = 0;
  if (c.state === 'suspended') {
    // BOUND the resume.
    //
    // On WebKit, resume() on a context that has never been unlocked by a user
    // gesture returns a promise that stays PENDING — it does not reject, it
    // simply never settles until audio is unlocked. Awaiting it unbounded parks
    // this call indefinitely, and when the user finally clicks something an
    // hour later every parked call resolves at once, sees a running context,
    // and schedules its burst. That is the "sound turns up an hour later,
    // sometimes several at once" report. The header above claims this class of
    // bug was fixed by not scheduling against a frozen clock, but the await
    // itself was left unbounded, which reintroduces it by another route.
    //
    // No prompt resume means no gesture in hand, so drop the burst.
    // `armAudioUnlock` resumes the context during the next real gesture, and
    // bursts after that schedule normally.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resumed = await Promise.race([
      c.resume().then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), RESUME_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
    if (!resumed) return null;
    // The context is running, but a Bluetooth sink woken by this resume is not
    // necessarily consuming yet — pad the schedule so the burst isn't dropped.
    wakeLead = WAKE_LEAD_SECONDS;
  } else if (isTauri && Date.now() > lastAudioEndsAt + SINK_HOT_WINDOW_MS) {
    // Context never suspended (idle grace), but the SINK may have: PipeWire
    // suspends an idle BT node after ~5 s of silence, and samples scheduled
    // into its spin-up are dropped, not buffered. Pad exactly as if we had
    // resumed. Desktop-only — see SINK_HOT_WINDOW_MS.
    wakeLead = WAKE_LEAD_SECONDS;
  }
  return c.state === 'running' ? { c, wakeLead } : null;
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

/** Wall-clock time (ms) the last scheduled audio (burst OR preview) rang out —
 *  drives the sink-cold check in `readyContext`. Separate from `burstEndsAt`,
 *  which is a throttle and deliberately ignores previews. */
let lastAudioEndsAt = 0;

/** Longest any single voice can ring for after its start offset (chime osc1 is
 *  0.35 s; a little slack so we never cut a tail off). */
const VOICE_TAIL_SECONDS = 0.4;

/** Pending idle-suspend timer, so a new burst can cancel a scheduled suspend. */
let suspendTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Suspend the shared context once the last voice has rung out.
 *
 * A `running` AudioContext keeps its audio render thread churning every
 * 128-frame quantum for the life of the document — even with nothing connected
 * to `destination` — and holds the output device open, which keeps the system
 * audio daemon awake too. Before this, the first consolidate resumed the
 * context and nothing ever suspended it, so the tab burned a slice of CPU on
 * silence forever. That is invisible on a desktop and very much not invisible
 * on a two-core laptop.
 *
 * Suspending between bursts is free: `readyContext` resumes on demand, and
 * resume latency is orders of magnitude below the gap between two consolidates.
 */
function scheduleSuspend(afterSeconds: number): void {
  if (suspendTimer !== null) clearTimeout(suspendTimer);
  suspendTimer = setTimeout(() => {
    suspendTimer = null;
    // Re-check state: another burst may have resumed it while we waited.
    if (ctx && ctx.state === 'running') void ctx.suspend().catch(() => {});
  }, (afterSeconds + VOICE_TAIL_SECONDS + SUSPEND_IDLE_GRACE_SECONDS) * 1000);
}

/**
 * Play the consolidate cascade for `blanks` removed notes.
 *
 * Async only because the context may need resuming first; callers fire and
 * forget. Never throws.
 */
// Arm at module load, not on first use: the first consolidate is exactly the
// one that would otherwise be silent, and by then the gesture that could have
// unlocked the context has already passed.
armAudioUnlock();

export async function playConsolidateSound(
  style: ConsolidateSoundStyle,
  blanks: number,
  accelerate: boolean,
): Promise<void> {
  if (style === 'off' || blanks <= 0) return;
  // Make sure a gesture-driven unlock is pending for the next attempt, even if
  // this one is about to be dropped for want of a resumed context.
  armAudioUnlock();
  // Nothing to hear in a background tab, and scheduling there just queues audio
  // that fires when the user comes back.
  if (typeof document !== 'undefined' && document.hidden) return;
  if (Date.now() < burstEndsAt) return;

  const requestedAt = Date.now();
  const ready = await readyContext();
  if (!ready) return;
  const { c, wakeLead } = ready;
  // Belt and braces on the same failure mode: if getting here took long enough
  // that this is no longer feedback for the consolidate that caused it, play
  // nothing. Silence beats a sound with no cause.
  if (Date.now() - requestedAt > MAX_SCHEDULING_LAG_MS) return;

  // Solitaire is one swoosh per three notes; chimes are one per note. Both are
  // capped so a huge consolidate doesn't allocate thousands of nodes.
  const voices = style === 'chimes'
    ? Math.min(blanks, MAX_VOICES)
    : Math.min(Math.max(1, Math.ceil(blanks / 3)), MAX_VOICES);
  const offsets = buildOffsets(voices, accelerate, 0.04);

  const start = c.currentTime + wakeLead;
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

  const span = wakeLead + (offsets[offsets.length - 1] ?? 0);
  // The overlap throttle deliberately EXCLUDES the wake lead: it exists to
  // stop cascades stacking into a smear, and folding the lead in silently
  // dropped a second short consolidate arriving within ~half a second of the
  // first — a case that has always played. A burst that overlaps another's
  // lead-in merely starts during its silence, which is not a smear.
  burstEndsAt = Date.now() + (offsets[offsets.length - 1] ?? 0) * 1000;
  lastAudioEndsAt = Date.now() + (span + VOICE_TAIL_SECONDS) * 1000;
  scheduleSuspend(span);
}

/** Preview used by the sound picker: three voices, starting slow. */
export async function previewConsolidateSound(style: ConsolidateSoundStyle): Promise<void> {
  if (style === 'off') return;
  const ready = await readyContext();
  if (!ready) return;
  const { c, wakeLead } = ready;
  // Gaps: 0.25 s then 0.15 s — starts slow, gets faster, like a real cascade.
  const gaps = [0, 0.25, 0.4];
  const scale = [523, 659, 880];
  for (let i = 0; i < 3; i++) {
    const t = c.currentTime + wakeLead + gaps[i];
    if (style === 'chimes') chime(c, t, scale[i]);
    else swoosh(c, t);
  }
  lastAudioEndsAt = Date.now() + (wakeLead + gaps[gaps.length - 1] + VOICE_TAIL_SECONDS) * 1000;
  scheduleSuspend(wakeLead + gaps[gaps.length - 1]);
}

/** Test seam — resets the module singletons between cases. */
export function __resetConsolidateSoundForTests(): void {
  if (suspendTimer !== null) clearTimeout(suspendTimer);
  suspendTimer = null;
  ctx = null;
  burstEndsAt = 0;
  lastAudioEndsAt = 0;
}

/** Exposed for tests: the offset schedule is the part with real logic in it. */
export const __testables = { buildOffsets, MAX_BURST_SECONDS, MAX_VOICES, WAKE_LEAD_SECONDS };
