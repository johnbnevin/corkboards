import { useEffect, useState } from 'react';

/**
 * Follow `value`, but only after it has stopped changing for `delayMs`.
 *
 * For inputs whose value drives expensive work. The classic case here is the
 * "hide notes containing…" box: every keystroke re-ran the entire feed pipeline
 * — dedupe, classify, filter and sort the whole note list, then recount
 * hashtags — over thousands of events, so the text appeared a noticeable beat
 * after it was typed. The input itself must stay bound to the raw value so it
 * still feels instant; only the *consumer* reads the debounced one.
 *
 * Clearing is not debounced: emptying the field restores the unfiltered feed on
 * the next tick, because waiting to show MORE content reads as a hang, while
 * waiting to hide some reads as normal.
 */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (value === debounced) return;
    // Always go through a timer rather than setting state in the effect body:
    // a synchronous setState here would cascade an extra render pass. A zero
    // delay is enough to make clearing feel immediate — see the note above.
    const isCleared = value === '' || value == null;
    const timer = setTimeout(() => setDebounced(value), isCleared ? 0 : delayMs);
    return () => clearTimeout(timer);
  }, [value, debounced, delayMs]);

  return debounced;
}
