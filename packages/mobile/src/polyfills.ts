/**
 * Runtime polyfills that must be installed before any app module is evaluated.
 *
 * ## AbortSignal.timeout / AbortSignal.any
 *
 * React Native 0.81 REPLACES the global `AbortSignal` with the
 * `abort-controller@3` shim — see
 * `react-native/Libraries/Core/setUpXHR.js`:
 *
 *     polyfillGlobal('AbortSignal',
 *       () => require('abort-controller/dist/abort-controller').AbortSignal);
 *
 * and `polyfillGlobal` overwrites the global unconditionally (the existing
 * descriptor is configurable, so Hermes' own implementation, if present, loses).
 * That shim predates both static helpers: it defines `class AbortSignal extends
 * EventTarget` and nothing else — no `timeout`, no `any`.
 *
 * The app calls `AbortSignal.timeout(...)` in ~77 places and `AbortSignal.any(...)`
 * in ~13, on essentially every relay query, profile fetch, upload and zap. Each
 * one throws `TypeError: AbortSignal.timeout is not a function` — so without
 * this file the mobile app's entire data layer fails at the first network call.
 * Web and desktop are unaffected: browsers and WebKit have both natively.
 *
 * Installed feature-detected, so this becomes a no-op the moment React Native
 * ships a spec-complete AbortSignal.
 */

type AbortSignalCtor = typeof AbortSignal & {
  timeout?: (ms: number) => AbortSignal;
  any?: (signals: Iterable<AbortSignal>) => AbortSignal;
};

/**
 * Abort a controller with a reason where supported.
 *
 * The RN shim's `abort()` takes no argument and never populates `signal.reason`,
 * so assign it directly. Consumers (including TanStack Query and our own
 * `useSessionAbort`) check `signal.reason` to tell a timeout from a deliberate
 * cancellation.
 */
function abortWith(controller: AbortController, reason: unknown): void {
  const signal = controller.signal as AbortSignal & { reason?: unknown };
  if (signal.reason === undefined) {
    try {
      Object.defineProperty(signal, 'reason', {
        value: reason,
        configurable: true,
        writable: true,
      });
    } catch {
      /* non-configurable in some engines — the abort itself still fires */
    }
  }
  controller.abort();
}

/** Build the DOMException the spec requires, falling back to a plain Error. */
function timeoutError(): unknown {
  if (typeof DOMException === 'function') {
    return new DOMException('signal timed out', 'TimeoutError');
  }
  const err = new Error('signal timed out');
  err.name = 'TimeoutError';
  return err;
}

function abortError(): unknown {
  if (typeof DOMException === 'function') {
    return new DOMException('This operation was aborted', 'AbortError');
  }
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

export function installAbortSignalPolyfills(): void {
  const Ctor = globalThis.AbortSignal as AbortSignalCtor | undefined;
  if (typeof Ctor !== 'function') return;

  if (typeof Ctor.timeout !== 'function') {
    Ctor.timeout = (ms: number): AbortSignal => {
      const controller = new AbortController();
      const timer = setTimeout(() => abortWith(controller, timeoutError()), ms);
      // Do not keep the RN timer queue alive longer than needed when the caller
      // finishes first and drops its reference to the signal.
      controller.signal.addEventListener?.('abort', () => clearTimeout(timer));
      return controller.signal;
    };
  }

  if (typeof Ctor.any !== 'function') {
    Ctor.any = (signals: Iterable<AbortSignal>): AbortSignal => {
      const controller = new AbortController();
      const list = [...signals];

      // If one is already aborted, mirror it immediately — no listeners needed.
      const already = list.find((s) => s.aborted);
      if (already) {
        abortWith(controller, (already as AbortSignal & { reason?: unknown }).reason ?? abortError());
        return controller.signal;
      }

      const cleanups: Array<() => void> = [];
      const onAbort = (source: AbortSignal) => () => {
        for (const fn of cleanups) fn();
        abortWith(controller, (source as AbortSignal & { reason?: unknown }).reason ?? abortError());
      };
      for (const source of list) {
        const handler = onAbort(source);
        source.addEventListener?.('abort', handler);
        cleanups.push(() => source.removeEventListener?.('abort', handler));
      }
      return controller.signal;
    };
  }

  // `throwIfAborted` is spec'd alongside the above and equally absent from the
  // shim. Cheap to add, and it keeps error shapes consistent with web.
  const proto = Ctor.prototype as AbortSignal & { throwIfAborted?: () => void };
  if (typeof proto.throwIfAborted !== 'function') {
    proto.throwIfAborted = function throwIfAborted(this: AbortSignal & { reason?: unknown }) {
      if (this.aborted) throw this.reason ?? abortError();
    };
  }
}

installAbortSignalPolyfills();
