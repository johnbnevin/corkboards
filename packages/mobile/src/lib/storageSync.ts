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

export type StorageSyncListener = (key: string, value: string | null, origin?: string) => void

const listeners = new Set<StorageSyncListener>()

export function subscribeStorageSync(fn: StorageSyncListener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function emitStorageSync(key: string, value: string | null, origin?: string): void {
  for (const fn of listeners) {
    try { fn(key, value, origin) } catch { /* one listener must not break the rest */ }
  }
}
