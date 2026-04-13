/**
 * threadTree — Pure functions for Nostr thread tree building.
 *
 * Shared between web and mobile. No DOM, React, or relay dependencies.
 */

interface NostrEvent {
  id: string
  kind: number
  pubkey: string
  created_at: number
  content: string
  tags: string[][]
  sig: string
}

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

  if (rootTag || replyTag) {
    return { root: rootTag?.[1], reply: replyTag?.[1] || rootTag?.[1], hints }
  }
  // Positional fallback (NIP-10)
  if (eTags.length === 1) return { root: eTags[0][1], reply: eTags[0][1], hints }
  if (eTags.length > 1) return { root: eTags[0][1], reply: eTags[eTags.length - 1][1], hints }
  return { hints }
}

/** Get the immediate parent event ID of a reply */
export function getParentId(event: NostrEvent): string | null {
  const eTags = event.tags.filter(t => t[0] === 'e')
  if (eTags.length === 0) return null
  const replyTag = eTags.find(t => t[3] === 'reply')
  if (replyTag) return replyTag[1]
  return eTags[eTags.length - 1][1]
}

/** Check if event is a direct reply to the given eventId */
export function isDirectReply(event: NostrEvent, eventId: string): boolean {
  return getParentId(event) === eventId
}

/** Get the root event ID from an event's thread tags */
export function getRootId(event: NostrEvent): string | null {
  return parseThreadTags(event).root ?? null
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
      const parentId = getParentId(e)
      if (parentId) {
        const arr = childrenByParent.get(parentId) || []
        arr.push(e)
        childrenByParent.set(parentId, arr)
      }
    }
  }

  // Inject just-posted reply
  if (injectedReply && injectedReply.kind !== 7) {
    const parentId = getParentId(injectedReply)
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
 * Extract the ancestor chain from target back to root.
 * Returns events in order: [root, ..., parent, target]
 */
export function getAncestorChain(
  events: NostrEvent[],
  targetId: string,
  rootId: string,
): NostrEvent[] {
  if (targetId === rootId) return []
  const eventMap = new Map<string, NostrEvent>()
  for (const e of events) eventMap.set(e.id, e)

  const chain: NostrEvent[] = []
  let currentId: string | null = targetId
  const visited = new Set<string>()

  while (currentId && currentId !== rootId && chain.length < 20) {
    if (visited.has(currentId)) break
    visited.add(currentId)
    const event = eventMap.get(currentId)
    if (!event) break
    chain.unshift(event)
    currentId = getParentId(event)
  }

  return chain
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
