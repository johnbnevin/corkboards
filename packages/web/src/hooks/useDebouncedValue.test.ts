/**
 * Debounced value used by the feed's text filter.
 *
 * The property that matters: typing must not push a new value through on every
 * keystroke (each one re-filters the whole feed), but clearing the field must
 * restore the unfiltered feed promptly rather than after another full delay.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedValue } from './useDebouncedValue';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useDebouncedValue', () => {
  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('start', 250));
    expect(result.current).toBe('start');
  });

  it('withholds a new value until the delay has elapsed', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), {
      initialProps: { v: '' },
    });
    rerender({ v: 'g' });
    expect(result.current).toBe('');

    act(() => { vi.advanceTimersByTime(249); });
    expect(result.current).toBe('');

    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe('g');
  });

  it('emits only the final value when typing quickly', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), {
      initialProps: { v: '' },
    });
    for (const v of ['g', 'go', 'goo', 'good']) {
      rerender({ v });
      act(() => { vi.advanceTimersByTime(100) });
    }
    // Nothing has settled yet — the timer restarted on each keystroke.
    expect(result.current).toBe('');
    act(() => { vi.advanceTimersByTime(250); });
    expect(result.current).toBe('good');
  });

  it('clears promptly instead of waiting out the delay', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), {
      initialProps: { v: 'filtered' },
    });
    rerender({ v: '' });
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe('');
  });

  it('does not schedule anything when the value is unchanged', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), {
      initialProps: { v: 'same' },
    });
    rerender({ v: 'same' });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current).toBe('same');
  });
});
