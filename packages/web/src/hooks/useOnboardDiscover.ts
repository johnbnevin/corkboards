import { useState, useEffect, useRef, useCallback } from 'react'
import { type NostrEvent, NSchema as n } from '@nostrify/nostrify'
import { createRelayFresh } from '@/components/NostrProvider'
import { useQueryClient } from '@tanstack/react-query'
import { cacheProfile } from '@/lib/cacheStore'
import { nip19 } from 'nostr-tools'

// Relays to query in parallel for onboard discovery
const RELAYS = ['wss://nos.lol', 'wss://relay.nostr.net', 'wss://relay.ditto.pub']

// Curators whose follows seed the onboard discovery feed
const CURATOR_NPUBS = [
  'npub1v89nr2zax8ef0ceyu9te0sjyqv3newa3e82m0rd4kye3ekeyhv2sqf30cc',
  'npub18ams6ewn5aj2n3wt2qawzglx9mr4nzksxhvrdc4gzrecw7n5tvjqctp424',
  'npub1xtscya34g58tk0z605fvr788k263gsu6cy9x0mhnm87echrgufzsevkk5s',
  'npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p',
  'npub1aeh2zw4elewy5682lxc6xnlqzjnxksq303gwu2npfaxd49vmde6qcq4nwx',
  'npub1rge90czqx9s8p6mua8vy8su5ud3hnw94tgtdrcwev8q42xff233qnrwvz4',
  'npub1gwa27rpgum8mr9d30msg8cv7kwj2lhav2nvmdwh3wqnsa5vnudxqlta2sz',
  'npub1ztzpz9xepmxsry7jqdhjc32dh5wtktpnn9kjq5eupdwdq06gdn6s0d7zxv',
  'npub1a6c3jcdj23ptzcuflek8a04f4hc2cdkat95pd6n3r8jjrwyzrw0q43lfrr',
  'npub1gjslp8z6a25h0u7egps6cl0z9fncu5lk9euqc0w6anajuvyct9aq0gn0lf',
]

const CURATOR_PUBKEYS: string[] = CURATOR_NPUBS.map(npub => {
  try {
    const d = nip19.decode(npub)
    return d.type === 'npub' ? (d.data as string) : null
  } catch { return null }
}).filter(Boolean) as string[]

/** Query a single relay (fresh connection, closed immediately after). */
async function queryRelayOnce(
  url: string,
  filter: { kinds: number[]; authors: string[]; limit: number },
  timeoutMs = 5000,
): Promise<NostrEvent[]> {
  try {
    const relay = createRelayFresh(url, { backoff: false })
    const events = await relay.query([filter], { signal: AbortSignal.timeout(timeoutMs) })
    try { relay.close() } catch { /* */ }
    return events
  } catch { return [] }
}

export function useOnboardDiscover(userFollows: string[], enabled: boolean, userPubkey?: string) {
  const queryClient = useQueryClient()
  const [notes, setNotes] = useState<NostrEvent[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const ranForPubkeyRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const userFollowsRef = useRef(userFollows)
  useEffect(() => { userFollowsRef.current = userFollows })

  const cacheProfileEvent = useCallback((ev: NostrEvent) => {
    try {
      const metadata = n.json().pipe(n.metadata()).parse(ev.content)
      queryClient.setQueryData(['author', ev.pubkey], { metadata, event: ev })
      cacheProfile(ev.pubkey, metadata, ev).catch(() => {})
    } catch { /* invalid metadata */ }
  }, [queryClient])

  useEffect(() => {
    if (userPubkey && ranForPubkeyRef.current && ranForPubkeyRef.current !== userPubkey) {
      ranForPubkeyRef.current = null
      setNotes([])
      abortRef.current?.abort()
    }
  }, [userPubkey])

  useEffect(() => {
    if (!enabled || ranForPubkeyRef.current === (userPubkey ?? '')) return
    ranForPubkeyRef.current = userPubkey ?? ''

    abortRef.current = new AbortController()
    const signal = abortRef.current.signal

    setIsLoading(true)

    async function run() {
      try {
        // Step 1: Fetch curator contact lists from all 3 relays in parallel — take the union
        const curatorListResults = await Promise.all(
          RELAYS.map(url => queryRelayOnce(url, { kinds: [3], authors: CURATOR_PUBKEYS, limit: 50 }, 5000))
        )
        if (signal.aborted) return

        // Merge: keep newest event per curator pubkey across all relay results
        const latestPerCurator = new Map<string, NostrEvent>()
        for (const events of curatorListResults) {
          for (const ev of events) {
            const existing = latestPerCurator.get(ev.pubkey)
            if (!existing || ev.created_at > existing.created_at) {
              latestPerCurator.set(ev.pubkey, ev)
            }
          }
        }

        const userFollowSet = new Set(userFollowsRef.current)

        // Collect all candidate follows: pubkeys from curators' follows, excluding already-followed
        const candidateSet = new Set<string>()
        for (const ev of latestPerCurator.values()) {
          for (const tag of ev.tags) {
            if (tag[0] === 'p' && tag[1] && !userFollowSet.has(tag[1])) {
              candidateSet.add(tag[1])
            }
          }
        }

        const candidates = Array.from(candidateSet)
        if (candidates.length === 0 || signal.aborted) return

        // Step 2: Fetch notes + profiles for candidates in parallel batches of 30
        // Each batch queries all 3 relays in parallel and takes the union.
        const BATCH_SIZE = 30
        const MAX_CANDIDATES = 150
        const cappedCandidates = candidates.slice(0, MAX_CANDIDATES)

        const seenNoteIds = new Set<string>()
        const seenAuthors = new Set<string>()
        const collected: NostrEvent[] = []

        const addNotes = (newNotes: NostrEvent[]) => {
          const accepted: NostrEvent[] = []
          for (const ev of newNotes) {
            if (seenNoteIds.has(ev.id)) continue
            if (seenAuthors.has(ev.pubkey)) continue
            if (ev.tags.some(t => t[0] === 'e')) continue // only root notes
            seenNoteIds.add(ev.id)
            seenAuthors.add(ev.pubkey)
            accepted.push(ev)
          }
          if (accepted.length > 0) {
            collected.push(...accepted)
            setNotes([...collected])
          }
        }

        // Process first batch immediately to show something fast
        const firstBatch = cappedCandidates.slice(0, BATCH_SIZE)
        const firstResults = await Promise.all(
          RELAYS.map(url =>
            Promise.all([
              queryRelayOnce(url, { kinds: [1], authors: firstBatch, limit: firstBatch.length }),
              queryRelayOnce(url, { kinds: [0], authors: firstBatch, limit: firstBatch.length }),
            ])
          )
        )
        if (signal.aborted) return

        for (const [noteResults, profileResults] of firstResults) {
          for (const ev of profileResults) cacheProfileEvent(ev)
          addNotes(noteResults)
        }

        if (signal.aborted) return

        // Remaining batches in parallel
        const remainingBatches: string[][] = []
        for (let i = BATCH_SIZE; i < cappedCandidates.length; i += BATCH_SIZE) {
          remainingBatches.push(cappedCandidates.slice(i, i + BATCH_SIZE))
        }

        await Promise.all(
          remainingBatches.map(async batch => {
            if (signal.aborted) return
            const results = await Promise.all(
              RELAYS.map(url =>
                Promise.all([
                  queryRelayOnce(url, { kinds: [1], authors: batch, limit: batch.length }),
                  queryRelayOnce(url, { kinds: [0], authors: batch, limit: batch.length }),
                ])
              )
            )
            if (signal.aborted) return
            for (const [noteResults, profileResults] of results) {
              for (const ev of profileResults) cacheProfileEvent(ev)
              addNotes(noteResults)
            }
          })
        )

      } catch (err) {
        if (!signal.aborted) console.error('[onboard-discover]', err)
      } finally {
        if (!signal.aborted) setIsLoading(false)
      }
    }

    run()
    return () => { abortRef.current?.abort() }
  }, [enabled, cacheProfileEvent, userPubkey])

  return { notes, isLoading }
}
