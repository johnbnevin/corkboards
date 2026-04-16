/**
 * useOnboardDiscover — Onboarding discovery feed from curator pubkeys.
 *
 * Port of packages/web/src/hooks/useOnboardDiscover.ts for mobile.
 * Uses MMKV cache store instead of web IDB.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { type NostrEvent, NSchema as n } from '@nostrify/nostrify';
import { createRelay } from '../lib/NostrProvider';
import { useQueryClient } from '@tanstack/react-query';
import { cacheProfile } from '../lib/cacheStore';
import { nip19 } from 'nostr-tools';

const RELAYS = ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.ditto.pub'];

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
];

const CURATOR_PUBKEYS: string[] = CURATOR_NPUBS.map(npub => {
  try {
    const d = nip19.decode(npub);
    return d.type === 'npub' ? (d.data as string) : null;
  } catch { return null; }
}).filter(Boolean) as string[];

async function queryRelay(
  url: string,
  filter: { kinds: number[]; authors: string[]; limit: number },
  timeoutMs = 4000,
): Promise<NostrEvent[]> {
  try {
    const relay = createRelay(url, { backoff: false });
    const events = await relay.query([filter], { signal: AbortSignal.timeout(timeoutMs) });
    try { relay.close(); } catch { /* */ }
    return events;
  } catch { return []; }
}

export function useOnboardDiscover(userFollows: string[], enabled: boolean, userPubkey?: string) {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState<NostrEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const ranForPubkeyRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const userFollowsRef = useRef(userFollows);
  useEffect(() => { userFollowsRef.current = userFollows; });

  const cacheProfileEvent = useCallback((ev: NostrEvent) => {
    try {
      const metadata = n.json().pipe(n.metadata()).parse(ev.content);
      queryClient.setQueryData(['author', ev.pubkey], { metadata, event: ev });
      cacheProfile(ev.pubkey, metadata, ev);
    } catch { /* invalid metadata */ }
  }, [queryClient]);

  useEffect(() => {
    if (userPubkey && ranForPubkeyRef.current && ranForPubkeyRef.current !== userPubkey) {
      ranForPubkeyRef.current = null;
      setNotes([]);
      abortRef.current?.abort();
    }
  }, [userPubkey]);

  useEffect(() => {
    if (!enabled || ranForPubkeyRef.current === (userPubkey ?? '')) return;
    ranForPubkeyRef.current = userPubkey ?? '';

    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    setIsLoading(true);

    async function run() {
      try {
        const curatorEvents = await queryRelay(RELAYS[0], {
          kinds: [3], authors: CURATOR_PUBKEYS, limit: 50,
        }, 6000);
        if (signal.aborted) return;

        const userFollowSet = new Set(userFollowsRef.current);
        const curatorFollows: string[][] = [];
        const latestPerCurator = new Map<string, NostrEvent>();
        for (const ev of curatorEvents) {
          const existing = latestPerCurator.get(ev.pubkey);
          if (!existing || ev.created_at > existing.created_at) {
            latestPerCurator.set(ev.pubkey, ev);
          }
        }
        for (const ev of latestPerCurator.values()) {
          const follows = ev.tags
            .filter(t => t[0] === 'p' && t[1] && !userFollowSet.has(t[1]))
            .map(t => t[1]);
          if (follows.length > 0) curatorFollows.push(follows);
        }
        if (curatorFollows.length === 0 || signal.aborted) return;

        const seenNoteIds = new Set<string>();
        const seenAuthors = new Set<string>();
        let relayIdx = 0;

        const addNotes = (newNotes: NostrEvent[]) => {
          const accepted: NostrEvent[] = [];
          for (const ev of newNotes) {
            if (seenNoteIds.has(ev.id)) continue;
            if (seenAuthors.has(ev.pubkey)) continue;
            if (ev.tags.some(t => t[0] === 'e')) continue;
            seenNoteIds.add(ev.id);
            seenAuthors.add(ev.pubkey);
            accepted.push(ev);
          }
          if (accepted.length > 0) {
            setNotes(prev => [...prev, ...accepted]);
          }
        };

        const curatorOffsets = new Array(curatorFollows.length).fill(0);
        const PICKS_PER_ROUND = 5;
        const MAX_ROUNDS = 8;

        for (let round = 0; round < MAX_ROUNDS; round++) {
          if (signal.aborted) break;
          let anyProgress = false;

          for (let ci = 0; ci < curatorFollows.length; ci++) {
            if (signal.aborted) break;
            const follows = curatorFollows[ci];
            const offset = curatorOffsets[ci];
            if (offset >= follows.length) continue;

            const picks: string[] = [];
            let idx = offset;
            while (picks.length < PICKS_PER_ROUND && idx < follows.length) {
              if (!seenAuthors.has(follows[idx])) picks.push(follows[idx]);
              idx++;
            }
            curatorOffsets[ci] = idx;
            if (picks.length === 0) continue;

            const relayUrl = RELAYS[relayIdx % RELAYS.length];
            relayIdx++;
            anyProgress = true;

            const [noteEvents, profileEvents] = await Promise.all([
              queryRelay(relayUrl, { kinds: [1], authors: picks, limit: picks.length }),
              queryRelay(relayUrl, { kinds: [0], authors: picks, limit: picks.length }),
            ]);

            for (const ev of profileEvents) cacheProfileEvent(ev);
            addNotes(noteEvents);
          }

          if (!anyProgress) break;
        }
      } catch (err) {
        if (!signal.aborted) console.error('[onboard-discover]', err);
      } finally {
        if (!signal.aborted) setIsLoading(false);
      }
    }

    run();
    return () => { abortRef.current?.abort(); };
  }, [enabled, cacheProfileEvent, userPubkey]);

  return { notes, isLoading };
}
