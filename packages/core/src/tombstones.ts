/**
 * The removal log that makes union-merging safe.
 *
 * `stateMerge` unions two devices' id sets so nothing is ever lost. The cost of
 * a union is that deletions don't stick: un-dismiss a note, delete a corkboard,
 * unpin a post, and the next merge with a device that still has it brings it
 * back. A tombstone — id → when it was removed — is what tells the merge that
 * the absence is a fact rather than a gap.
 *
 * ## Recorded by diffing, not by call sites
 *
 * The obvious implementation is to call `recordRemoval` from every place that
 * removes something. There are a dozen such places (expand, undoDismiss,
 * clearDismissed, undismissMany, dismissAllCollapsed, delete-board, unpin,
 * unbookmark…) and any one of them added later and forgotten would silently
 * resurrect data. So instead the log is derived: the storage layer diffs the
 * previous and next value of the handful of merge-classified keys on every
 * write, and anything that disappeared is tombstoned. One choke point, and a
 * new removal path cannot fail to be covered because it has to write the key.
 *
 * Storage-agnostic on purpose: this owns the map and its serialization, each
 * platform owns loading and saving the string.
 */

import {
  SET_MERGE_KEYS,
  KEYED_MERGE_KEYS,
  MAP_MERGE_KEYS,
  mergeTombstones,
  type TombstoneMap,
} from './stateMerge'

/** Storage key for the persisted log. Deliberately NOT in BACKED_UP_KEYS —
 *  it travels in its own field of the v5 snapshot and merges by newest-wins,
 *  which the generic last-write-wins path would get wrong. */
export const TOMBSTONE_STORAGE_KEY = 'corkboard:tombstones'

/**
 * How long a removal is remembered.
 *
 * A tombstone has to outlive the oldest snapshot that might still carry the id,
 * or the deletion is undone by a device coming back from a long absence. Six
 * months covers any realistic gap; beyond that, resurrecting a handful of ids
 * is a better failure than an unbounded log.
 */
export const TOMBSTONE_MAX_AGE_SECS = 180 * 24 * 60 * 60

/** Hard cap on remembered removals, oldest dropped first. */
export const MAX_TOMBSTONES = 20_000

const MERGE_CLASSIFIED_KEYS = new Set<string>([
  ...SET_MERGE_KEYS,
  ...KEYED_MERGE_KEYS,
  ...MAP_MERGE_KEYS,
])

/** True when writes to this key should be diffed for removals. */
export function isMergeClassifiedKey(key: string): boolean {
  return MERGE_CLASSIFIED_KEYS.has(key)
}

let log: TombstoneMap = {}

/** Ids present in a stored value, whatever its shape. */
function idsOf(key: string, raw: string | null | undefined): Set<string> {
  const out = new Set<string>()
  if (raw == null) return out
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return out }

  if (SET_MERGE_KEYS.includes(key)) {
    if (Array.isArray(parsed)) for (const v of parsed) if (typeof v === 'string') out.add(v)
  } else if (KEYED_MERGE_KEYS.includes(key)) {
    if (Array.isArray(parsed)) {
      for (const v of parsed) {
        if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
          out.add((v as { id: string }).id)
        }
      }
    }
  } else if (MAP_MERGE_KEYS.includes(key)) {
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const k of Object.keys(parsed as Record<string, unknown>)) out.add(k)
    }
  }
  return out
}

/**
 * Diff a write and record anything that disappeared.
 *
 * Returns the removed ids (mostly for tests and logging). A write that adds or
 * changes nothing records nothing, so this is safe to call on every write.
 *
 * `prev == null` is treated as "no previous value", NOT as "everything was
 * removed" — a first write, or a write after an eviction, must not tombstone
 * the world.
 */
export function recordRemovalsFromWrite(
  key: string,
  prev: string | null | undefined,
  next: string | null | undefined,
  nowSecs: number,
): string[] {
  if (!isMergeClassifiedKey(key)) return []
  if (prev == null) return []

  const before = idsOf(key, prev)
  if (before.size === 0) return []
  const after = idsOf(key, next)

  const removed: string[] = []
  for (const id of before) if (!after.has(id)) removed.push(id)
  if (removed.length === 0) return []

  const graves = log[key] ?? (log[key] = {})
  for (const id of removed) graves[id] = nowSecs
  prune(nowSecs)
  return removed
}

/** Merge another device's log in (newest wins per id). */
export function mergeInTombstones(incoming: TombstoneMap | undefined): void {
  if (!incoming) return
  log = mergeTombstones(log, incoming)
}

/** The current log. Treat as read-only. */
export function getTombstones(): TombstoneMap {
  return log
}

export function serializeTombstones(): string {
  return JSON.stringify(log)
}

/** Replace the log from persisted JSON. Invalid input yields an empty log. */
export function loadTombstones(raw: string | null | undefined): void {
  if (!raw) { log = {}; return }
  try {
    const parsed = JSON.parse(raw)
    log = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as TombstoneMap : {}
  } catch {
    log = {}
  }
}

/** Forget everything (logout / wipe). */
export function clearTombstones(): void {
  log = {}
}

/** Count of remembered removals across all keys. */
export function tombstoneCount(): number {
  let n = 0
  for (const ids of Object.values(log)) n += Object.keys(ids).length
  return n
}

/** Drop expired entries, then oldest-first until under the cap. */
export function prune(nowSecs: number): void {
  const cutoff = nowSecs - TOMBSTONE_MAX_AGE_SECS
  const flat: { key: string; id: string; at: number }[] = []

  for (const [key, ids] of Object.entries(log)) {
    for (const [id, at] of Object.entries(ids)) {
      if (at < cutoff) delete ids[id]
      else flat.push({ key, id, at })
    }
    if (Object.keys(ids).length === 0) delete log[key]
  }

  if (flat.length <= MAX_TOMBSTONES) return
  flat.sort((a, b) => a.at - b.at)
  for (const { key, id } of flat.slice(0, flat.length - MAX_TOMBSTONES)) {
    delete log[key]?.[id]
    if (log[key] && Object.keys(log[key]).length === 0) delete log[key]
  }
}
