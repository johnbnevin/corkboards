/**
 * threadTree — Pure functions for Nostr thread tree building.
 *
 * Shared between web and mobile. No DOM, React, or relay dependencies.
 */

import { type NostrEvent } from '@nostrify/nostrify'
import { isValidEventId } from './noteClassifier'

/** A node in the thread tree */
export interface ThreadNode {
  event: NostrEvent
  children: ThreadNode[]
  reactions: NostrEvent[]
}

/** Parse NIP-10 thread markers from an event's e-tags */
export function parseThreadTags(event: NostrEvent): {
  root?: string
  reply?: string
  hints: string[]
} {
  const eTags = event.tags.filter(t => t[0] === 'e')
  const rootTag = eTags.find(t => t[3] === 'root')
  const replyTag = eTags.find(t => t[3] === 'reply')

  const hints: string[] = []
  for (const t of eTags) {
    if (t[2] && t[2].startsWith('wss://')) hints.push(t[2])
  }

  // Only surface well-formed 64-hex IDs (parity with classifyNote), so a
  // malformed e-tag value can't poison the tree with a bogus root/parent.
  const clean = (id: string | undefined) => (isValidEventId(id) ? id : undefined)

  if (rootTag || replyTag) {
    return { root: clean(rootTag?.[1]), reply: clean(replyTag?.[1] || rootTag?.[1]), hints }
  }
  // Positional fallback (NIP-10)
  if (eTags.length === 1) return { root: clean(eTags[0]?.[1]), reply: clean(eTags[0]?.[1]), hints }
  if (eTags.length > 1) return { root: clean(eTags[0]?.[1]), reply: clean(eTags[eTags.length - 1]?.[1]), hints }
  return { hints }
}

/** Get the immediate parent event ID of a reply */
export function getParentId(event: NostrEvent): string | null {
  const eTags = event.tags.filter(t => t[0] === 'e')
  if (eTags.length === 0) return null
  const replyTag = eTags.find(t => t[3] === 'reply')
  if (isValidEventId(replyTag?.[1])) return replyTag![1]
  const last = eTags[eTags.length - 1]?.[1]
  return isValidEventId(last) ? last : null
}

/**
 * Parent reference for TREE ATTACHMENT: the NIP-10 `e` parent when present,
 * otherwise the NIP-22 addressable parent `a`-coordinate, otherwise the external
 * `i` reference. Lets a kind-1111 reply attach to an addressable root (e.g.
 * long-form) that it references by coordinate rather than event id. (M2)
 */
export function getParentRef(event: NostrEvent): string | null {
  const eid = getParentId(event)
  if (eid) return eid
  const aTag = event.tags.find(t => t[0] === 'a' && t[1])
  if (aTag) return aTag[1]!
  const iTag = event.tags.find(t => t[0] === 'i' && t[1])
  if (iTag) return iTag[1]!
  return null
}

/** Addressable/replaceable coordinate (kind:pubkey[:d]) used to map a coordinate
 *  reference back to the concrete event id present in the thread set. */
function threadCoordinate(e: NostrEvent): string | null {
  if (e.kind >= 30000 && e.kind < 40000) {
    const d = e.tags.find(t => t[0] === 'd')?.[1] ?? ''
    return `${e.kind}:${e.pubkey}:${d}`
  }
  if (e.kind === 0 || e.kind === 3 || (e.kind >= 10000 && e.kind < 20000)) {
    return `${e.kind}:${e.pubkey}`
  }
  return null
}

/**
 * Build a ThreadNode tree from a flat array of events.
 *
 * @param events - All events in the thread (target + replies + reactions)
 * @param rootId - The root event ID to build the tree from
 * @param injectedReply - Optional just-posted reply to inject into the tree
 * @returns The root ThreadNode, or null if root event not found
 */
export function buildThreadTree(
  events: NostrEvent[],
  rootId: string,
  injectedReply?: NostrEvent | null,
): ThreadNode | null {
  const eventMap = new Map<string, NostrEvent>()
  for (const e of events) eventMap.set(e.id, e)

  const rootEvent = eventMap.get(rootId)
  if (!rootEvent) return null

  // Map addressable/replaceable coordinates → their concrete event id in this set
  // so a reply that references its parent by coordinate (NIP-22) attaches. (M2)
  const coordToId = new Map<string, string>()
  for (const e of events) {
    const coord = threadCoordinate(e)
    if (coord) coordToId.set(coord, e.id)
  }
  const resolveParent = (e: NostrEvent): string | null => {
    const ref = getParentRef(e)
    if (!ref) return null
    return coordToId.get(ref) ?? ref
  }

  // Group children by parent ID
  const childrenByParent = new Map<string, NostrEvent[]>()
  const reactionsByTarget = new Map<string, NostrEvent[]>()

  for (const e of events) {
    if (e.id === rootId) continue
    if (e.kind === 7) {
      // Reaction — find which event it targets (last e-tag)
      const eTags = e.tags.filter(t => t[0] === 'e')
      const targetId = eTags[eTags.length - 1]?.[1]
      if (targetId) {
        const arr = reactionsByTarget.get(targetId) || []
        arr.push(e)
        reactionsByTarget.set(targetId, arr)
      }
    } else if (e.kind === 6 || e.kind === 16 || e.kind === 9735) {
      // Reposts (6, 16) and zap receipts (9735) are engagement signals,
      // not thread participants — skip them to avoid duplicating the original post
      continue
    } else {
      const parentId = resolveParent(e)
      if (parentId) {
        const arr = childrenByParent.get(parentId) || []
        arr.push(e)
        childrenByParent.set(parentId, arr)
      }
    }
  }

  // Inject just-posted reply
  if (injectedReply && injectedReply.kind !== 7) {
    const parentId = resolveParent(injectedReply)
    if (parentId) {
      const arr = childrenByParent.get(parentId) || []
      if (!arr.some(e => e.id === injectedReply.id)) {
        arr.push(injectedReply)
        childrenByParent.set(parentId, arr)
      }
    }
  }

  const seen = new Set<string>()

  function buildNode(event: NostrEvent): ThreadNode {
    seen.add(event.id)
    const children = (childrenByParent.get(event.id) || [])
      .filter(e => !seen.has(e.id))
      .sort((a, b) => a.created_at - b.created_at)
      .map(e => { seen.add(e.id); return buildNode(e) })
    const reactions = reactionsByTarget.get(event.id) || []
    return { event, children, reactions }
  }

  return buildNode(rootEvent)
}

/**
 * Flatten a ThreadNode tree into a depth-annotated array for virtualized rendering.
 * Pre-order traversal: parent before children.
 */
export interface FlatThreadRow {
  node: ThreadNode
  depth: number
  isTarget: boolean
}

export function flattenTree(
  tree: ThreadNode,
  targetId: string,
  collapsedIds?: Set<string>,
): FlatThreadRow[] {
  const rows: FlatThreadRow[] = []

  function walk(node: ThreadNode, depth: number) {
    rows.push({ node, depth, isTarget: node.event.id === targetId })
    if (collapsedIds?.has(node.event.id)) return
    for (const child of node.children) {
      walk(child, depth + 1)
    }
  }

  walk(tree, 0)
  return rows
}

/**
 * Deduplicate events by id, preferring the version with more e-tags
 * (more specific threading info from NIP-10 compliant clients).
 */
export function deduplicateEvents(events: NostrEvent[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>()
  for (const e of events) {
    const existing = byId.get(e.id)
    if (!existing) {
      byId.set(e.id, e)
    } else {
      const existingETags = existing.tags.filter(t => t[0] === 'e').length
      const newETags = e.tags.filter(t => t[0] === 'e').length
      if (newETags > existingETags) byId.set(e.id, e)
    }
  }
  return [...byId.values()]
}
