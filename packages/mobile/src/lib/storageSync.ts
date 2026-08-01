/**
 * Mobile equivalent of web's `idb-storage-sync` CustomEvent.
 *
 * Web dispatches a window event on every external storage write so hooks
 * holding React state can follow along. Mobile had NO equivalent — a backup
 * merge wrote MMKV and every mounted hook kept rendering its stale copy until
 * app restart, which is half of "restore never sticks" on the phone. This is
 * the missing bus: storage writers that bypass a hook's own setState call
 * `emitStorageSync`, and stores subscribe.
 *
 * `value` is the raw stored string, or null for a deletion. `origin` lets a
 * writer skip re-applying its own write.
 */

import { DeviceEventEmitter } from 'react-native'

export type StorageSyncListener = (key: string, value: string | null, origin?: string) => void

const listeners = new Set<StorageSyncListener>()

/**
 * The DeviceEventEmitter channel `useLocalStorage` listens on.
 *
 * There were TWO storage-change buses on mobile that never talked to each
 * other: this module's listener Set (used by useBookmarks / useCollapsedNotes)
 * and `useLocalStorage`'s DeviceEventEmitter channel — and the corkboard list
 * and active tab are read through `useLocalStorage`. So a silent backup merge
 * wrote the desktop's corkboards into MMKV, emitted on THIS bus, and
 * HomeScreen kept rendering the state it captured at mount: "the phone didn't
 * pick up desktop changes until I refreshed the page", while bookmarks (on
 * this bus) updated live. Both directions are bridged here so there is one
 * bus with two subscription styles.
 */
const RN_SYNC_EVENT = 'mobile-storage-sync'

export function subscribeStorageSync(fn: StorageSyncListener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function emitStorageSync(key: string, value: string | null, origin?: string): void {
  for (const fn of listeners) {
    try { fn(key, value, origin) } catch { /* one listener must not break the rest */ }
  }
  // Forward to the hook bus so `useLocalStorage` consumers (corkboards, active
  // tab, dismissed notes, pins) re-read after an external write.
  try {
    DeviceEventEmitter.emit(RN_SYNC_EVENT, { key, originId: origin })
  } catch { /* emitter unavailable (tests) — Set listeners already ran */ }
}
