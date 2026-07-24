/**
 * React Native 0.81 overwrites the global AbortSignal with the
 * `abort-controller@3` shim, which has neither `AbortSignal.timeout` nor
 * `AbortSignal.any`. The app calls those on essentially every network request,
 * so without the polyfill every relay query, profile fetch, upload and zap
 * throws `TypeError: AbortSignal.timeout is not a function`.
 *
 * These tests assert the polyfill supplies working implementations. They start
 * by deleting whatever the environment provides, so they exercise the polyfill
 * itself rather than jsdom/Node's built-ins.
 */
import { installAbortSignalPolyfills } from '../polyfills';

// `timeout`/`any` are non-optional on the DOM lib's AbortSignal, so the delete
// goes through an index signature — this mirrors the React Native runtime,
// where the abort-controller shim genuinely lacks both.
type Patchable = Record<'timeout' | 'any', unknown>;

function asPatchable(): Patchable {
  return globalThis.AbortSignal as unknown as Patchable;
}

function stripNativeStatics() {
  const Ctor = asPatchable();
  delete Ctor.timeout;
  delete Ctor.any;
  installAbortSignalPolyfills();
}

describe('AbortSignal polyfills', () => {
  beforeEach(stripNativeStatics);

  it('installs both static helpers', () => {
    expect(typeof AbortSignal.timeout).toBe('function');
    expect(typeof AbortSignal.any).toBe('function');
  });

  it('timeout() aborts after the delay with a TimeoutError reason', async () => {
    const signal = AbortSignal.timeout(10);
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(signal.aborted).toBe(true);
    expect((signal as AbortSignal & { reason?: { name?: string } }).reason?.name)
      .toBe('TimeoutError');
  });

  it('timeout() does not abort early', async () => {
    const signal = AbortSignal.timeout(1000);
    await new Promise((r) => setTimeout(r, 30));
    expect(signal.aborted).toBe(false);
  });

  it('any() aborts as soon as one input signal aborts', async () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = AbortSignal.any([a.signal, b.signal]);
    expect(combined.aborted).toBe(false);
    b.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(combined.aborted).toBe(true);
  });

  it('any() reflects a signal that was already aborted', () => {
    const a = new AbortController();
    a.abort();
    expect(AbortSignal.any([a.signal]).aborted).toBe(true);
  });

  it('any() composes with timeout(), which is how the app uses it', async () => {
    const session = new AbortController();
    const combined = AbortSignal.any([session.signal, AbortSignal.timeout(10)]);
    await new Promise((r) => setTimeout(r, 40));
    expect(combined.aborted).toBe(true);
  });

  it('throwIfAborted() throws only once aborted', () => {
    const c = new AbortController();
    expect(() => c.signal.throwIfAborted()).not.toThrow();
    c.abort();
    expect(() => c.signal.throwIfAborted()).toThrow();
  });

  it('does not clobber a runtime that already provides the statics', () => {
    const sentinel = () => new AbortController().signal;
    const Ctor = asPatchable();
    Ctor.timeout = sentinel;
    installAbortSignalPolyfills();
    expect(Ctor.timeout).toBe(sentinel);
  });
});
