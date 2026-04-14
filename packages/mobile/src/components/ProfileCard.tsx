/**
 * ProfileCard — Compact profile card with avatar, display name, npub,
 * NIP-05, website, lightning address, relay list, and follow/mute actions.
 * For use in lists and modals. Mirrors web's ProfileCard.tsx.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Clipboard,
  Alert,
} from 'react-native';
import { nip19 } from 'nostr-tools';
import { useAuthor } from '../hooks/useAuthor';
import { useNip65Relays } from '../hooks/useNip65Relays';
import { genUserName } from '@core/genUserName';
import { STORAGE_KEYS } from '@core/storageKeys';
import { SizeGuardedImage } from './SizeGuardedImage';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { Dimensions } from 'react-native';

interface ProfileCardProps {
  pubkey: string;
  compact?: boolean;
  onPress?: (pubkey: string) => void;
  stats?: {
    follows?: number;
    notes?: number;
  };
}

export function ProfileCard({ pubkey, compact = false, onPress, stats }: ProfileCardProps) {
  const { data: author, isLoading } = useAuthor(pubkey);
  const { fetchRelaysForPubkey } = useNip65Relays();
  const [copied, setCopied] = useState(false);
  const [relaysOpen, setRelaysOpen] = useState(false);
  const [relays, setRelays] = useState<string[]>([]);
  const [relaysLoading, setRelaysLoading] = useState(false);
  const [bannerHeightPct] = useLocalStorage<number>(STORAGE_KEYS.BANNER_HEIGHT_PCT, 0);
  const [bannerFitMode] = useLocalStorage<string>(STORAGE_KEYS.BANNER_FIT_MODE, 'crop');
  const [naturalBannerPct, setNaturalBannerPct] = useState(0);
  const effectiveBannerPct = bannerHeightPct === 0 ? naturalBannerPct : bannerHeightPct;
  const bannerWidth = Dimensions.get('window').width - 24; // container padding

  const metadata = author?.metadata;
  const displayName = metadata?.display_name || metadata?.name || genUserName(pubkey);
  const npub = nip19.npubEncode(pubkey);
  const shortNpub = `${npub.slice(0, 12)}...${npub.slice(-8)}`;

  const nip05Display = metadata?.nip05?.startsWith('_@')
    ? metadata.nip05.slice(2)
    : metadata?.nip05;

  const websiteDisplay = metadata?.website
    ? (() => {
        try {
          const url = new URL(metadata.website);
          const fullPath = url.hostname + url.pathname.replace(/\/$/, '');
          return fullPath.length <= 30 ? fullPath : fullPath.slice(0, 27) + '...';
        } catch {
          return metadata.website!.length <= 30 ? metadata.website : metadata.website!.slice(0, 27) + '...';
        }
      })()
    : null;

  const lightningDisplay = metadata?.lud16
    ? metadata.lud16.length <= 30
      ? metadata.lud16
      : metadata.lud16.slice(0, 27) + '...'
    : null;

  const copyNpub = useCallback(() => {
    Clipboard.setString(npub);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [npub]);

  const handleRelaysToggle = useCallback(() => {
    const willOpen = !relaysOpen;
    setRelaysOpen(willOpen);
    if (willOpen && relays.length === 0) {
      setRelaysLoading(true);
      fetchRelaysForPubkey(pubkey).then((r) => {
        setRelays(r);
        setRelaysLoading(false);
      });
    }
  }, [relaysOpen, relays.length, pubkey, fetchRelaysForPubkey]);

  if (isLoading) {
    return (
      <View style={styles.container}>
        <View style={styles.skeletonRow}>
          <View style={styles.skeletonAvatar} />
          <View style={styles.skeletonTextBlock}>
            <View style={styles.skeletonLine} />
            <View style={[styles.skeletonLine, { width: '60%' }]} />
          </View>
        </View>
      </View>
    );
  }

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={() => onPress?.(pubkey)}
      activeOpacity={onPress ? 0.7 : 1}
      disabled={!onPress}
    >
      {/* Banner */}
      {!compact && (
        metadata?.banner ? (
          <SizeGuardedImage
            uri={metadata.banner}
            style={[styles.banner, effectiveBannerPct > 0 ? { height: bannerWidth * effectiveBannerPct / 100 } : undefined]}
            type="image"
            resizeMode={bannerFitMode === 'crop' ? 'cover' : 'contain'}
          />
        ) : (
          <View style={styles.bannerPlaceholder} />
        )
      )}

      {/* Avatar + name row */}
      <View style={[styles.profileRow, !compact && styles.profileRowOverlap]}>
        {metadata?.picture ? (
          <SizeGuardedImage
            uri={metadata.picture}
            style={compact ? styles.avatarCompact : styles.avatar}
            type="avatar"
          />
        ) : (
          <View style={[compact ? styles.avatarCompact : styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarLetter}>
              {displayName.slice(0, 2).toUpperCase()}
            </Text>
          </View>
        )}
        <View style={styles.nameBlock}>
          <View style={styles.nameRow}>
            <Text style={styles.displayName} numberOfLines={1}>
              {displayName}
            </Text>
            {metadata?.bot && (
              <View style={styles.botBadge}>
                <Text style={styles.botBadgeText}>BOT</Text>
              </View>
            )}
          </View>
          {metadata?.nip05 && (
            <View style={styles.nip05Row}>
              <Text style={styles.nip05Check}>&#10003;</Text>
              <Text style={styles.nip05Text} numberOfLines={1}>{nip05Display}</Text>
            </View>
          )}
        </View>
      </View>

      {/* About (non-compact only) */}
      {metadata?.about && !compact && (
        <Text style={styles.about} numberOfLines={4}>
          {metadata.about}
        </Text>
      )}

      {/* Info row: npub, stats, website, lightning */}
      <View style={styles.infoRow}>
        <TouchableOpacity onPress={copyNpub} style={styles.npubRow}>
          <Text style={styles.npubText}>{shortNpub}</Text>
          <Text style={styles.copyIcon}>{copied ? '✓' : '⧉'}</Text>
        </TouchableOpacity>

        {stats?.follows !== undefined && (
          <Text style={styles.statText}>
            <Text style={styles.statNum}>{stats.follows}</Text> following
          </Text>
        )}
      </View>

      {(websiteDisplay || lightningDisplay) && (
        <View style={styles.linksRow}>
          {websiteDisplay && (
            <Text style={styles.websiteText} numberOfLines={1}>
              ⊕ {websiteDisplay}
            </Text>
          )}
          {lightningDisplay && (
            <Text style={styles.lightningText} numberOfLines={1}>
              ⚡ {lightningDisplay}
            </Text>
          )}
        </View>
      )}

      {/* Relays toggle */}
      <TouchableOpacity style={styles.relayToggle} onPress={handleRelaysToggle}>
        <Text style={styles.relayToggleText}>
          {relaysOpen ? '▾' : '▸'} Relays
        </Text>
        {!relaysLoading && relays.length > 0 && (
          <View style={styles.relayBadge}>
            <Text style={styles.relayBadgeText}>{relays.length}</Text>
          </View>
        )}
      </TouchableOpacity>

      {relaysOpen && (
        <View style={styles.relayList}>
          {relaysLoading ? (
            <ActivityIndicator color="#b3b3b3" size="small" />
          ) : relays.length > 0 ? (
            relays.map((relay, i) => (
              <Text key={i} style={styles.relayItem} numberOfLines={1}>
                {relay.replace('wss://', '').replace('ws://', '').replace(/\/$/, '')}
              </Text>
            ))
          ) : (
            <Text style={styles.relayEmpty}>No relays published</Text>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#2a2a2a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#404040',
    overflow: 'hidden',
  },
  // Skeleton
  skeletonRow: { flexDirection: 'row', padding: 14, gap: 10 },
  skeletonAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#333' },
  skeletonTextBlock: { flex: 1, gap: 8, justifyContent: 'center' },
  skeletonLine: { height: 12, borderRadius: 6, backgroundColor: '#333', width: '80%' },

  // Banner
  banner: { width: '100%', height: 100 },
  bannerPlaceholder: { width: '100%', height: 80, backgroundColor: '#333' },

  // Profile row
  profileRow: { flexDirection: 'row', alignItems: 'flex-start', padding: 12, gap: 10 },
  profileRowOverlap: { marginTop: -24 },

  // Avatar
  avatar: { width: 56, height: 56, borderRadius: 28, borderWidth: 2, borderColor: '#2a2a2a' },
  avatarCompact: { width: 40, height: 40, borderRadius: 20, borderWidth: 2, borderColor: '#2a2a2a' },
  avatarFallback: { backgroundColor: '#444', alignItems: 'center', justifyContent: 'center' },
  avatarLetter: { color: '#b3b3b3', fontSize: 18, fontWeight: '600' },

  // Name
  nameBlock: { flex: 1, paddingTop: 4 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  displayName: { fontSize: 16, fontWeight: 'bold', color: '#f2f2f2', flexShrink: 1 },
  botBadge: { backgroundColor: '#333', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 },
  botBadgeText: { fontSize: 9, color: '#b3b3b3', fontWeight: '600' },

  // NIP-05
  nip05Row: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  nip05Check: { color: '#a855f7', fontSize: 12 },
  nip05Text: { color: '#a855f7', fontSize: 12, flexShrink: 1 },

  // About
  about: { fontSize: 13, color: '#b3b3b3', lineHeight: 18, paddingHorizontal: 12, marginBottom: 8 },

  // Info row
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, flexWrap: 'wrap' },
  npubRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  npubText: { fontFamily: 'monospace', fontSize: 10, color: '#b3b3b3' },
  copyIcon: { color: '#b3b3b3', fontSize: 12 },
  statText: { fontSize: 12, color: '#b3b3b3' },
  statNum: { color: '#f2f2f2', fontWeight: '600' },

  // Links
  linksRow: { flexDirection: 'row', gap: 12, paddingHorizontal: 12, marginTop: 6, flexWrap: 'wrap' },
  websiteText: { fontSize: 12, color: '#a855f7' },
  lightningText: { fontSize: 12, color: '#f59e0b' },

  // Relays
  relayToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8 },
  relayToggleText: { fontSize: 12, color: '#b3b3b3' },
  relayBadge: { backgroundColor: '#333', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 },
  relayBadgeText: { fontSize: 10, color: '#b3b3b3' },
  relayList: { paddingHorizontal: 12, paddingBottom: 10, backgroundColor: '#252525', borderRadius: 6, marginHorizontal: 8, marginBottom: 8, padding: 8 },
  relayItem: { fontFamily: 'monospace', fontSize: 11, color: '#b3b3b3', marginBottom: 2 },
  relayEmpty: { fontSize: 12, color: '#666', fontStyle: 'italic' },
});
