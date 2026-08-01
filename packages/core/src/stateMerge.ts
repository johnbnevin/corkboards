/**
 * Merging cloud state into local state.
 *
 * ## Why this exists
 *
 * Restore used to be a wholesale replace: the newest cloud snapshot overwrote
 * every backed-up key. That is only safe if you can be sure the snapshot is
 * strictly ahead of local, which is exactly what you cannot know with two
 * devices writing the same slot — so the app grew a thicket of gates to avoid
 * ever running it (restore only when local looks empty; suggest only when the
 * cloud has 5+ more dismissed notes). The gates worked, in the sense that they
 * prevented data loss. They also prevented the thing the backup is FOR: a
 * second device picking up where the first left off.
 *
 * The fix is not a better rule for choosing a winner. It is to stop choosing.
 * Almost everything backed up here is set-like and grows monotonically —
 * dismissed ids, saved ids, bookmarks, pins — and a union of two devices' sets
 * loses nothing from either. Once the merge cannot destroy anything, the app is
 * free to pull the cloud state aggressively, which is what the user actually
 * wants: local is a cache, the cloud is the state, a wiped device restores
 * itself, and work done offline merges up when the connection returns.
 *
 * ## Deletions
 *
 * Union alone would resurrect anything you remove: un-dismiss a note, delete a
 * corkboard, unpin a post, and the next merge with a device that still has it
 * brings it back. So removals are recorded as tombstones — id → when it was
 * removed — and a tombstone suppresses an incoming id unless that id was
 * re-added after the tombstone was written. That makes deletion durable without
 * giving up the union.
 *
 * Nothing here touches storage or the network; it is all pure so the rules can
 * be tested exhaustively.
 */

/** Snapshot format version written by this build. */
export const STATE_FORMAT_VERSION = 5

/**
 * Keys whose value is a JSON array of opaque ids, merged by union.
 * Order is not meaningful for any of these.
 */
export const SET_MERGE_KEYS: readonly string[] = [
  'collapsed-notes',
  'dismissed-notes',
  'dismissed-thread-roots',
  'saved-minimized-notes',
  'nostr-bookmark-ids',
  'nostr-pinned-note-ids',
  'nostr-friends',
  'nostr-browse-relays',
  'nostr-rss-feeds',
  'corkboard:blocked-relays',
]

/**
 * Keys whose value is a JSON array of objects with an `id`, merged per item.
 * A corkboard edited on one device and a corkboard created on another must both
 * survive, which a whole-list last-write-wins cannot do.
 */
export const KEYED_MERGE_KEYS: readonly string[] = [
  'nostr-custom-feeds',
]

/**
 * Keys whose value is a JSON object keyed by an opaque id (tab id), merged per
 * entry with the newer snapshot winning each entry.
 */
export const MAP_MERGE_KEYS: readonly string[] = [
  'corkboard:tab-filters',
]

/**
 * Keys whose value is a single number that only ever moves FORWARD, merged by
 * taking the larger of the two.
 *
 * "I have seen notifications up to time T" is monotonic: reading more can only
 * raise T. Left in the generic scalar bucket it was last-write-wins on the
 * SNAPSHOT timestamp, so a device that had not opened notifications in weeks
 * could push its older marker over a newer one purely by having saved more
 * recently — and the badge would resurrect notifications the user had already
 * read on the other device. Max-merge makes that impossible in both
 * directions, without needing to know which device is "right".
 */
export const NUMERIC_MAX_MERGE_KEYS: readonly string[] = [
  'corkboard:notifications-last-seen',
]

/** Removal log: key → id → unix seconds when it was removed. */
export type TombstoneMap = Record<string, Record<string, number>>

/** One side of a merge. */
export interface StateSnapshot {
  /** Raw serialized values exactly as stored, key → JSON string (or null). */
  keys: Record<string, string | null>
  /** When this snapshot was taken, unix seconds. */
  savedAt: number
  /** Removals known to this side. */
  tombstones?: TombstoneMap
}

export interface MergeResult {
  /** The full merged state — every key from either side, at its merged value. */
  keys: Record<string, string | null>
  /** Union of both sides' tombstones, newest wins per id. */
  tombstones: TombstoneMap
  /** Ids dropped from local because the other side tombstoned them. */
  removals: { key: string; ids: string[] }[]
  /**
   * Keys whose merged value differs from local. This is the write list — an
   * apply step that wrote all of `keys` would touch every backed-up key on
   * every merge, waking every `useLocalStorage` subscriber for no reason.
   */
  changedKeys: string[]
}

function parseArray(raw: string | null | undefined): unknown[] | null {
  if (raw == null) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : null
  } catch { return null }
}

function parseObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (raw == null) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch { return null }
}

/** Newest-wins union of two tombstone maps. */
export function mergeTombstones(a: TombstoneMap = {}, b: TombstoneMap = {}): TombstoneMap {
  const out: TombstoneMap = {}
  for (const src of [a, b]) {
    for (const [key, ids] of Object.entries(src)) {
      const target = out[key] ?? (out[key] = {})
      for (const [id, at] of Object.entries(ids)) {
        if (!(id in target) || at > target[id]) target[id] = at
      }
    }
  }
  return out
}

/**
 * Merge one id-set key.
 *
 * An id survives if either side has it AND no tombstone for it is newer than
 * the snapshot that contributed it. Using the contributing snapshot's time as
 * the add-time is the conservative reading: we know the id was present when
 * that snapshot was taken, so a removal recorded after it is genuinely later.
 */
/**
 * Keys where a recorded REMOVAL outranks mere local presence.
 *
 * For every other key the local snapshot's `savedAt` stands in for "when each
 * local id was added", which is deliberately conservative: it keeps anything
 * the local snapshot still holds. But that proxy is a lie about individual
 * ids — they were added whenever the user added them, not when the snapshot
 * happened to be written. So one local autosave after another device's
 * deletion made EVERY local id look freshly re-added, every incoming grave was
 * outranked, and the merge applied zero changes while reporting success. That
 * is why "I removed a lot of saved notes on the desktop and the other device
 * never caught up (until a reload, which read the values the merge had already
 * written)".
 *
 * These three keys are the ones the repo already treats as routine churn —
 * `SAVED_CLEANUP_KEYS` in backupGuards never holds a merge for them, on the
 * stated grounds that people clean out Save for Later all the time. Letting a
 * removal win here costs at worst a re-save of something the user re-added on
 * another device between the two snapshots; blocking it costs cross-device
 * cleanup entirely. Dismissed notes, corkboards and pins keep the
 * conservative reading, where an accidental deletion is the worse outcome.
 */
const REMOVAL_WINS_KEYS = new Set([
  'collapsed-notes',
  'nostr-bookmark-ids',
  'saved-minimized-notes',
])

function mergeIdSet(
  key: string,
  local: StateSnapshot,
  remote: StateSnapshot,
  tombstones: TombstoneMap,
): { value: string | null; removed: string[] } {
  const localIds = parseArray(local.keys[key])
  const remoteIds = parseArray(remote.keys[key])
  if (localIds === null && remoteIds === null) return { value: local.keys[key] ?? null, removed: [] }

  const graves = tombstones[key] ?? {}
  const out: string[] = []
  const seen = new Set<string>()
  const removed: string[] = []

  const consider = (ids: unknown[] | null, addedAt: number) => {
    if (!ids) return
    for (const raw of ids) {
      if (typeof raw !== 'string' || seen.has(raw)) continue
      const removedAt = graves[raw]
      if (removedAt !== undefined && removedAt >= addedAt) {
        // Tombstoned after this snapshot saw it — the removal is the newer fact.
        if (!removed.includes(raw)) removed.push(raw)
        seen.add(raw)
        continue
      }
      seen.add(raw)
      out.push(raw)
    }
  }

  // Local first so local ordering is preserved for the ids both sides share.
  //
  // For the routine-churn keys, a grave carried by a snapshot NEWER than ours
  // outranks mere local presence. `local.savedAt` is a stand-in for "when each
  // local id was added" and it is a lie about individual ids: one local save
  // after another device's cleanup made every local id look freshly re-added,
  // so incoming removals were outranked and the merge changed nothing while
  // reporting success. Requiring the remote snapshot to be newer keeps the
  // genuine re-add case safe (a stale grave from an older snapshot still
  // loses), which is what stateMerge.test.ts's re-add case asserts.
  const localAddedAt = REMOVAL_WINS_KEYS.has(key) && remote.savedAt > local.savedAt
    ? 0
    : local.savedAt
  consider(localIds, localAddedAt)
  consider(remoteIds, remote.savedAt)

  return { value: JSON.stringify(out), removed }
}

/** Merge an array-of-objects-with-id key, newest snapshot winning per item. */
function mergeKeyedList(
  key: string,
  local: StateSnapshot,
  remote: StateSnapshot,
  tombstones: TombstoneMap,
): { value: string | null; removed: string[] } {
  const localList = parseArray(local.keys[key])
  const remoteList = parseArray(remote.keys[key])
  if (localList === null && remoteList === null) return { value: local.keys[key] ?? null, removed: [] }

  const graves = tombstones[key] ?? {}
  const byId = new Map<string, { item: Record<string, unknown>; at: number }>()
  const order: string[] = []
  const removed: string[] = []

  const consider = (list: unknown[] | null, at: number) => {
    if (!list) return
    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const item = raw as Record<string, unknown>
      const id = typeof item.id === 'string' ? item.id : null
      if (!id) continue
      const removedAt = graves[id]
      if (removedAt !== undefined && removedAt >= at) {
        if (!removed.includes(id)) removed.push(id)
        continue
      }
      const existing = byId.get(id)
      if (!existing) {
        byId.set(id, { item, at })
        order.push(id)
      } else if (at > existing.at) {
        // Newer snapshot's version of this board wins.
        byId.set(id, { item, at })
      }
    }
  }

  consider(localList, local.savedAt)
  consider(remoteList, remote.savedAt)

  return { value: JSON.stringify(order.map(id => byId.get(id)!.item)), removed }
}

/** Merge an object-keyed map, newer snapshot winning per entry. */
function mergeMap(
  key: string,
  local: StateSnapshot,
  remote: StateSnapshot,
  tombstones: TombstoneMap,
): { value: string | null; removed: string[] } {
  const localMap = parseObject(local.keys[key])
  const remoteMap = parseObject(remote.keys[key])
  if (localMap === null && remoteMap === null) return { value: local.keys[key] ?? null, removed: [] }

  const graves = tombstones[key] ?? {}
  const out: Record<string, unknown> = {}
  const removed: string[] = []

  const consider = (map: Record<string, unknown> | null, at: number, isNewer: boolean) => {
    if (!map) return
    for (const [id, value] of Object.entries(map)) {
      const removedAt = graves[id]
      if (removedAt !== undefined && removedAt >= at) {
        if (!removed.includes(id)) removed.push(id)
        continue
      }
      if (!(id in out) || isNewer) out[id] = value
    }
  }

  const remoteIsNewer = remote.savedAt > local.savedAt
  consider(localMap, local.savedAt, !remoteIsNewer)
  consider(remoteMap, remote.savedAt, remoteIsNewer)

  return { value: JSON.stringify(out), removed }
}

/**
 * Merge a remote snapshot into a local one.
 *
 * Set-like keys union (minus tombstones), keyed collections merge per item, and
 * everything else is last-write-wins on the snapshot timestamp. A key absent
 * from the remote snapshot is left alone — absence is not a deletion, or a
 * device that had never saved a given key would wipe it everywhere.
 */
export function mergeState(local: StateSnapshot, remote: StateSnapshot): MergeResult {
  const tombstones = mergeTombstones(local.tombstones, remote.tombstones)
  const keys: Record<string, string | null> = {}
  const removals: { key: string; ids: string[] }[] = []
  const changedKeys: string[] = []

  const allKeys = new Set([...Object.keys(local.keys), ...Object.keys(remote.keys)])
  const remoteIsNewer = remote.savedAt > local.savedAt

  for (const key of allKeys) {
    const before = local.keys[key] ?? null
    let merged: { value: string | null; removed: string[] }

    if (SET_MERGE_KEYS.includes(key)) {
      merged = mergeIdSet(key, local, remote, tombstones)
    } else if (KEYED_MERGE_KEYS.includes(key)) {
      merged = mergeKeyedList(key, local, remote, tombstones)
    } else if (MAP_MERGE_KEYS.includes(key)) {
      merged = mergeMap(key, local, remote, tombstones)
    } else if (NUMERIC_MAX_MERGE_KEYS.includes(key)) {
      const localNum = Number(JSON.parse(local.keys[key] ?? 'null'))
      const remoteNum = Number(JSON.parse(remote.keys[key] ?? 'null'))
      const best = Math.max(
        Number.isFinite(localNum) ? localNum : 0,
        Number.isFinite(remoteNum) ? remoteNum : 0,
      )
      // Absent on both sides stays absent — writing a 0 would be a value the
      // consumer then has to special-case.
      merged = {
        value: best > 0 ? JSON.stringify(best) : before,
        removed: [],
      }
    } else {
      // Scalars and anything unclassified: last-write-wins, but only when the
      // remote actually carries the key. A missing key means "this device never
      // wrote one", not "delete it".
      const remoteHas = key in remote.keys && remote.keys[key] != null
      merged = { value: remoteIsNewer && remoteHas ? remote.keys[key]! : before, removed: [] }
    }

    if (merged.removed.length > 0) removals.push({ key, ids: merged.removed })
    keys[key] = merged.value
    if (merged.value !== before) changedKeys.push(key)
  }

  return { keys, tombstones, removals, changedKeys }
}

/** True when applying this merge would drop something the user has locally. */
export function mergeRemovesLocalData(result: MergeResult): boolean {
  return result.removals.some(r => r.ids.length > 0)
}

/**
 * Does this snapshot carry ANY backed-up data at all?
 *
 * A backup blob that parses fine but holds no keys is not a state — it is the
 * empty envelope a broken build writes (the `keys` field was once dropped from
 * the serializer while its manifest kept advertising real stats). Applying it
 * as a restore "succeeds" with zero keys written, which reads as success while
 * restoring nothing; callers must refuse it instead.
 */
export function snapshotHasBackedUpData(
  snapshot: StateSnapshot,
  backedUpKeys: readonly string[],
): boolean {
  return backedUpKeys.some(k => snapshot.keys[k] != null)
}

/**
 * Merge a relay-fetched NIP-51 bookmark list (kind 10003) into local state.
 *
 * The old rule was a blind union, which made removal impossible: an id
 * removed locally (or by a restore) was re-added five minutes later when the
 * relay copy refreshed, because the union had no idea the absence was
 * deliberate. This is the same id-survives-unless-a-newer-grave-says-otherwise
 * rule as `mergeIdSet`, specialized for the relay direction:
 *
 * - every LOCAL id survives — local state is the live truth, and a grave for
 *   an id that is still present locally means it was re-added after removal;
 * - a RELAY id merges in unless a tombstone for it is at-or-after the relay
 *   event's created_at, in which case the removal is the newer fact and the
 *   relay copy is stale.
 */
export function mergeBookmarkSnapshot(
  localIds: string[],
  relayIds: string[],
  relayCreatedAtSecs: number,
  graves: Record<string, number> = {},
): { ids: string[]; changed: boolean } {
  const out = [...localIds]
  const seen = new Set(localIds)
  let changed = false
  for (const id of relayIds) {
    if (seen.has(id)) continue
    const removedAt = graves[id]
    if (removedAt !== undefined && removedAt >= relayCreatedAtSecs) continue
    seen.add(id)
    out.push(id)
    changed = true
  }
  return { ids: changed ? out : localIds, changed }
}

/**
 * True when the local snapshot holds content the remote one lacks — an id,
 * board, or map entry that would be lost if the cloud were taken as-is.
 *
 * Used after a pull-merge to decide what the change-detection baseline should
 * be. Setting the baseline to the merged local state (what both platforms used
 * to do unconditionally) marks local-only content as "already saved", so it
 * never pushed until the next unrelated edit. Setting it to the REMOTE state
 * makes the auto-save trigger see the local-only content as unsaved and push
 * the union. The check is membership-based, not string-based, on purpose:
 * the set keys' ordering differs per device (merge keeps local order first),
 * and a string comparison would see every reordering as a contribution —
 * two devices pushing their own orderings at each other forever.
 */
export function hasLocalContributions(local: StateSnapshot, remote: StateSnapshot): boolean {
  for (const key of SET_MERGE_KEYS) {
    const localIds = parseArray(local.keys[key])
    if (!localIds) continue
    const remoteIds = new Set(parseArray(remote.keys[key]) ?? [])
    for (const id of localIds) {
      if (typeof id === 'string' && !remoteIds.has(id)) return true
    }
  }
  for (const key of KEYED_MERGE_KEYS) {
    const localList = parseArray(local.keys[key])
    if (!localList) continue
    const remoteIdSet = new Set(
      (parseArray(remote.keys[key]) ?? [])
        .map(v => (v && typeof v === 'object' && !Array.isArray(v)) ? (v as { id?: unknown }).id : null)
        .filter((id): id is string => typeof id === 'string'),
    )
    for (const item of localList) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const id = (item as { id?: unknown }).id
      if (typeof id === 'string' && !remoteIdSet.has(id)) return true
    }
  }
  for (const key of MAP_MERGE_KEYS) {
    const localMap = parseObject(local.keys[key])
    if (!localMap) continue
    const remoteMap = parseObject(remote.keys[key]) ?? {}
    for (const id of Object.keys(localMap)) {
      if (!(id in remoteMap)) return true
    }
  }
  return false
}
