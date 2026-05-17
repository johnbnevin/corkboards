/**
 * DM hooks — NIP-17 (kind 1059 gift-wrap) sealed-sender DMs.
 *
 * NIP-04 (kind 4) DM support was removed in v0.7. The cipher itself is still
 * imported elsewhere for NIP-47 (NWC) and legacy own-data sync events, but
 * direct messaging uses NIP-17 exclusively.
 *
 * Mirrors web's DMProvider architecture adapted as hooks.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { NostrEvent } from '@nostrify/nostrify';
import { generateSecretKey } from 'nostr-tools';
import { finalizeEvent } from 'nostr-tools/pure';
import { encrypt as nip44Encrypt } from 'nostr-tools/nip44';
import { getConversationKey } from 'nostr-tools/nip44';
import { useNostr } from '../lib/NostrProvider';
import { useAuth } from '../lib/AuthContext';
import { formatConversationTime } from '@core/dmUtils';
import { secureRandomInt } from '@core/cryptoUtils';

export interface DecryptedMessage {
  id: string;
  content: string;
  created_at: number;
  pubkey: string;        // real author
  isMine: boolean;
  protocol: 'nip17';
}

export interface Conversation {
  partnerPubkey: string;
  lastMessage: string;
  lastActivity: number;
  unreadHint: boolean;
}

// ============================================================================
// NIP-17 — gift-wrapped sealed-sender DMs (kind 1059)
// Unwrapping sequence per NIP-17:
//   1. Decrypt gift-wrap (kind 1059) content via nip44 → yields seal JSON (kind 13)
//   2. Parse seal; seal.pubkey is the real sender
//   3. Decrypt seal content via nip44 → yields rumor JSON (kind 14, unsigned)
//   4. rumor.content is the plaintext message
// ============================================================================

/** Wrap a signer decrypt call with a hard timeout to prevent DM pane hangs. */
function withDecryptTimeout<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.then(v => { clearTimeout(timer); return v; }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Decryption timed out')), ms);
    }),
  ]);
}

/** Result of unwrapping a NIP-17 gift wrap, including partner resolution via rumor p-tag */
interface UnwrappedMessage extends DecryptedMessage {
  /** Conversation partner pubkey resolved from the rumor's p-tag */
  partnerPubkey: string;
}

async function unwrapGiftWrap(
  giftWrap: NostrEvent,
  pubkey: string,
  signer: { nip44: { decrypt(recipientPubkey: string, content: string): Promise<string> } },
): Promise<UnwrappedMessage | null> {
  try {
    // Step 1: Decrypt outer gift-wrap envelope (our private key, ephemeral pubkey)
    const sealJson = await withDecryptTimeout(signer.nip44.decrypt(giftWrap.pubkey, giftWrap.content));
    const seal = JSON.parse(sealJson) as NostrEvent;

    if (seal.kind !== 13) return null;

    // Step 2: Decrypt seal → rumor (sender's private key sealed to us)
    const rumorJson = await withDecryptTimeout(signer.nip44.decrypt(seal.pubkey, seal.content));
    const rumor = JSON.parse(rumorJson) as { kind: number; content: string; pubkey?: string; created_at?: number; id?: string; tags?: string[][] };

    if (rumor.kind !== 14) return null;

    const senderPubkey = seal.pubkey;
    const isMine = senderPubkey === pubkey;

    // Resolve conversation partner from the rumor's p-tag (NIP-17 spec)
    let partnerPubkey: string;
    if (isMine) {
      const pTag = rumor.tags?.find(t => t[0] === 'p');
      partnerPubkey = pTag?.[1] || 'unknown';
    } else {
      partnerPubkey = senderPubkey;
    }

    return {
      id: rumor.id || giftWrap.id,
      content: rumor.content,
      created_at: rumor.created_at || giftWrap.created_at,
      pubkey: senderPubkey,
      isMine,
      protocol: 'nip17',
      partnerPubkey,
    };
  } catch {
    if (__DEV__) console.warn('[useDMs] NIP-17 unwrap failed');
    return null;
  }
}

export function useNip17DMEvents() {
  const { nostr } = useNostr();
  const { pubkey, signer } = useAuth();

  return useQuery<{ messages: DecryptedMessage[]; partnerMap: Map<string, string> }>({
    queryKey: ['nip17-dm-events', pubkey],
    queryFn: async () => {
      if (!pubkey || !signer?.nip44) return { messages: [], partnerMap: new Map() };

      const wraps = await nostr.query(
        [{ kinds: [1059], '#p': [pubkey], limit: 200 }],
        { signal: AbortSignal.timeout(15000) },
      );

      const results = await Promise.allSettled(
        wraps.map(wrap => unwrapGiftWrap(wrap, pubkey, signer as { nip44: { decrypt: (r: string, c: string) => Promise<string> } })),
      );

      const messages: DecryptedMessage[] = [];
      const partnerMap = new Map<string, string>(); // messageId → partnerPubkey

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          const msg = result.value;
          messages.push(msg);
          partnerMap.set(msg.id, msg.partnerPubkey);
        }
      }

      messages.sort((a, b) => a.created_at - b.created_at);
      return { messages, partnerMap };
    },
    enabled: !!pubkey && !!(signer as { nip44?: unknown } | null)?.nip44,
    staleTime: 60_000,
  });
}

// ============================================================================
// Conversations — NIP-17 only
// ============================================================================

export function useConversations(): { conversations: Conversation[]; isLoading: boolean } {
  const { pubkey, signer: _signer } = useAuth();
  const { data: nip17Data, isLoading } = useNip17DMEvents();

  if (!pubkey) return { conversations: [], isLoading };

  const map = new Map<string, { lastActivity: number; lastMessage: string; unreadHint: boolean }>();

  // NIP-17 messages — partner is resolved from rumor p-tag by unwrapGiftWrap
  for (const msg of nip17Data?.messages ?? []) {
    const partner = nip17Data?.partnerMap.get(msg.id);
    if (!partner || partner === 'unknown') continue;

    const existing = map.get(partner);
    if (!existing || msg.created_at > existing.lastActivity) {
      map.set(partner, {
        lastActivity: msg.created_at,
        lastMessage: formatConversationTime(msg.created_at),
        unreadHint: !msg.isMine,
      });
    }
  }

  const conversations: Conversation[] = [...map.entries()].map(([partnerPubkey, data]) => ({
    partnerPubkey,
    ...data,
  }));

  conversations.sort((a, b) => b.lastActivity - a.lastActivity);
  return { conversations, isLoading };
}

// ============================================================================
// Per-conversation messages — NIP-17 only
// ============================================================================

export function useConversationMessages(partnerPubkey: string) {
  const { pubkey, signer } = useAuth();
  const { data: nip17Data } = useNip17DMEvents();

  return useQuery<DecryptedMessage[]>({
    queryKey: ['dm-messages', pubkey, partnerPubkey],
    queryFn: async () => {
      if (!pubkey || !signer) return [];

      const messages: DecryptedMessage[] = [];

      // NIP-17 messages from this partner
      for (const msg of nip17Data?.messages ?? []) {
        if (msg.pubkey === partnerPubkey || (msg.isMine && nip17Data?.partnerMap.get(msg.id) === partnerPubkey)) {
          messages.push(msg);
        }
      }

      // Dedup by ID, sort by time
      const seen = new Set<string>();
      const deduped = messages.filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      return deduped.sort((a, b) => a.created_at - b.created_at);
    },
    enabled: !!pubkey && !!signer,
    staleTime: 30_000,
  });
}

// ============================================================================
// Send DM — NIP-17 only
// ============================================================================

export function useSendDM() {
  const { nostr } = useNostr();
  const { pubkey, signer } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      recipientPubkey,
      content,
    }: {
      recipientPubkey: string;
      content: string;
    }) => {
      if (!pubkey || !signer) throw new Error('Not logged in');
      if (!(signer as { nip44?: unknown }).nip44) {
        throw new Error('Signer does not support NIP-44 encryption (required for NIP-17 DMs)');
      }
      return sendNip17(
        pubkey,
        signer as { nip44: { encrypt: (r: string, p: string) => Promise<string> }; signEvent: (t: unknown) => Promise<NostrEvent> },
        recipientPubkey,
        content,
        nostr,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['nip17-dm-events', pubkey] });
      queryClient.invalidateQueries({ queryKey: ['dm-messages'] });
    },
  });
}

async function sendNip17(
  senderPubkey: string,
  signer: { nip44: { encrypt(r: string, p: string): Promise<string> }; signEvent(t: unknown): Promise<NostrEvent> },
  recipientPubkey: string,
  content: string,
  nostr: { event(e: NostrEvent): Promise<void> },
): Promise<NostrEvent> {
  const now = Math.floor(Date.now() / 1000);

  // Cryptographically random offset within -2 days for metadata privacy (NIP-59)
  const randomizeTimestamp = (baseTime: number) => {
    const twoDaysInSeconds = 2 * 24 * 60 * 60;
    return baseTime - secureRandomInt(twoDaysInSeconds);
  };

  // Step 1: Create rumor (kind 14, unsigned plaintext DM)
  const rumor = {
    kind: 14,
    content,
    tags: [['p', recipientPubkey]],
    created_at: now,
    pubkey: senderPubkey,
  };
  const rumorJson = JSON.stringify(rumor);

  // Step 2: Create TWO seals (kind 13) — one encrypted to recipient, one to self
  // This matches web's DMProvider which creates sender + recipient copies.
  const recipientSealContent = await signer.nip44.encrypt(recipientPubkey, rumorJson);
  const senderSealContent = await signer.nip44.encrypt(senderPubkey, rumorJson);

  const [recipientSeal, senderSeal] = await Promise.all([
    signer.signEvent({
      kind: 13,
      content: recipientSealContent,
      tags: [],
      created_at: now,
    }),
    signer.signEvent({
      kind: 13,
      content: senderSealContent,
      tags: [],
      created_at: now,
    }),
  ]);

  // Step 3: Create TWO gift-wraps (kind 1059) — ephemeral keys for each
  const recipientEphemeral = generateSecretKey();
  const senderEphemeral = generateSecretKey();

  const recipientConvKey = getConversationKey(recipientEphemeral, recipientPubkey);
  const senderConvKey = getConversationKey(senderEphemeral, senderPubkey);

  const recipientGiftWrap = finalizeEvent({
    kind: 1059,
    content: nip44Encrypt(JSON.stringify(recipientSeal), recipientConvKey),
    tags: [['p', recipientPubkey]],
    created_at: randomizeTimestamp(now),
  }, recipientEphemeral);

  const senderGiftWrap = finalizeEvent({
    kind: 1059,
    content: nip44Encrypt(JSON.stringify(senderSeal), senderConvKey),
    tags: [['p', senderPubkey]],
    created_at: randomizeTimestamp(now),
  }, senderEphemeral);

  // Step 4: Publish both gift-wraps
  const results = await Promise.allSettled([
    nostr.event(recipientGiftWrap as NostrEvent),
    nostr.event(senderGiftWrap as NostrEvent),
  ]);

  if (results[0].status === 'rejected') {
    if (__DEV__) console.warn('[useDMs] Recipient gift wrap publish failed:', (recipientGiftWrap as NostrEvent).id);
  }
  if (results[1].status === 'rejected') {
    if (__DEV__) console.warn('[useDMs] Sender gift wrap publish failed:', (senderGiftWrap as NostrEvent).id);
  }

  if (results[0].status === 'rejected' && results[1].status === 'rejected') {
    throw new Error('Both gift wraps rejected by all relays');
  }

  return recipientGiftWrap as NostrEvent;
}
