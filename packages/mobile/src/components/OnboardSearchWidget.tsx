/**
 * OnboardSearchWidget -- Search widget for discovering users during onboarding.
 * Supports npub / nprofile / hex pubkey direct lookup and NIP-50 name search.
 *
 * Port of packages/web/src/components/OnboardSearchWidget.tsx for React Native.
 */
import { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { NRelay1 } from '@nostrify/nostrify';
import type { NostrEvent } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';
import { SizeGuardedImage } from './SizeGuardedImage';
import { NIP50_SEARCH_RELAY } from '../lib/relayConstants';

interface SearchResult {
  pubkey: string;
  name?: string;
  picture?: string;
  about?: string;
}

interface OnboardSearchWidgetProps {
  contactCount?: number;
  followTarget?: number;
  onSkip?: () => void;
  onSelectProfile: (pubkey: string) => void;
}

export function OnboardSearchWidget({
  contactCount = 0,
  followTarget = 10,
  onSkip,
  onSelectProfile,
}: OnboardSearchWidgetProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const relayRef = useRef<NRelay1 | null>(null);

  const tryDirectPubkey = useCallback((input: string): string | null => {
    const trimmed = input.trim();
    try {
      const d = nip19.decode(trimmed);
      if (d.type === 'npub') return d.data as string;
      if (d.type === 'nprofile') return (d.data as { pubkey: string }).pubkey;
    } catch { /* not bech32 */ }
    if (trimmed.length === 64 && /^[a-f0-9]+$/.test(trimmed)) return trimmed;
    return null;
  }, []);

  const clearSearch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    relayRef.current?.close();
    relayRef.current = null;
    setQuery('');
    setResults([]);
    setIsSearching(false);
  }, []);

  const handleInput = useCallback((value: string) => {
    setQuery(value);

    if (!value.trim()) {
      setResults([]);
      return;
    }

    // Direct npub / nprofile / hex pubkey
    const directPubkey = tryDirectPubkey(value);
    if (directPubkey) {
      onSelectProfile(directPubkey);
      clearSearch();
      return;
    }

    // Debounce name search
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      setResults([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      if (isSearching) {
        relayRef.current?.close();
        relayRef.current = null;
      }
      setIsSearching(true);
      try {
        const relay = new NRelay1(NIP50_SEARCH_RELAY, { backoff: false });
        relayRef.current = relay;

        const events: NostrEvent[] = [];
        const timeout = setTimeout(() => relay.close(), 5000);
        try {
          for await (const msg of relay.req([{ kinds: [0], search: value.trim(), limit: 8 }])) {
            if (msg[0] === 'EVENT') events.push(msg[2] as NostrEvent);
            else if (msg[0] === 'EOSE') break;
          }
        } finally {
          clearTimeout(timeout);
          relay.close();
          relayRef.current = null;
        }

        const parsed: SearchResult[] = events.map(e => {
          try {
            const meta = JSON.parse(e.content);
            return {
              pubkey: e.pubkey,
              name: meta.display_name || meta.name,
              picture: meta.picture,
              about: meta.about,
            };
          } catch {
            return { pubkey: e.pubkey };
          }
        });

        setResults(parsed);
      } catch {
        // Search relay unavailable
      } finally {
        setIsSearching(false);
      }
    }, 400);
  }, [tryDirectPubkey, onSelectProfile, clearSearch, isSearching]);

  const progressWidth = `${Math.min(contactCount / followTarget * 100, 100)}%`;

  return (
    <View style={styles.container}>
      <Text style={styles.description}>
        Follow anyone you find interesting. Take your time and curate your experience.
      </Text>

      {/* Progress bar */}
      <View style={styles.progressRow}>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: progressWidth as any }]} />
        </View>
        <Text style={styles.progressLabel}>{contactCount}/{followTarget}</Text>
      </View>

      {onSkip && (
        <Text style={styles.skipHint}>
          Already know your way around?{' '}
          <Text style={styles.skipLink} onPress={onSkip}>Skip onboarding</Text>
        </Text>
      )}

      {/* Search input */}
      <View style={styles.searchRow}>
        <Text style={styles.searchIcon}>{'\u{1F50D}'}</Text>
        <TextInput
          style={styles.searchInput}
          placeholder="Find someone by npub or name..."
          placeholderTextColor="#666"
          value={query}
          onChangeText={handleInput}
          autoCorrect={false}
          autoCapitalize="none"
        />
        {query ? (
          <TouchableOpacity onPress={clearSearch} style={styles.clearBtn}>
            <Text style={styles.clearText}>{'\u2715'}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Results */}
      {(results.length > 0 || isSearching) && (
        <View style={styles.resultsContainer}>
          {isSearching && results.length === 0 && (
            <View style={styles.searchingRow}>
              <ActivityIndicator color="#b3b3b3" size="small" />
              <Text style={styles.searchingText}>Searching...</Text>
            </View>
          )}
          <FlatList
            data={results}
            keyExtractor={r => r.pubkey}
            keyboardShouldPersistTaps="always"
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.resultRow}
                onPress={() => { onSelectProfile(item.pubkey); clearSearch(); }}
              >
                {item.picture ? (
                  <SizeGuardedImage uri={item.picture} style={styles.resultAvatar} type="avatar" />
                ) : (
                  <View style={[styles.resultAvatar, styles.resultAvatarPlaceholder]}>
                    <Text style={styles.resultAvatarLetter}>
                      {item.name?.charAt(0)?.toUpperCase() ?? '?'}
                    </Text>
                  </View>
                )}
                <View style={styles.resultInfo}>
                  <Text style={styles.resultName} numberOfLines={1}>
                    {item.name ?? 'Unknown'}
                  </Text>
                  {item.about ? (
                    <Text style={styles.resultAbout} numberOfLines={1}>{item.about}</Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            )}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 16,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(168, 85, 247, 0.3)',
    backgroundColor: 'rgba(168, 85, 247, 0.05)',
  },
  description: {
    fontSize: 13,
    color: '#b3b3b3',
    lineHeight: 19,
    marginBottom: 8,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  progressTrack: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#333',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#a855f7',
    borderRadius: 4,
  },
  progressLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: '#b3b3b3',
  },
  skipHint: {
    fontSize: 10,
    color: '#666',
    marginBottom: 10,
  },
  skipLink: {
    textDecorationLine: 'underline',
    color: '#b3b3b3',
  },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    paddingHorizontal: 10,
  },
  searchIcon: {
    fontSize: 14,
    marginRight: 6,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 10,
    color: '#f2f2f2',
    fontSize: 14,
  },
  clearBtn: {
    padding: 4,
  },
  clearText: {
    color: '#b3b3b3',
    fontSize: 14,
  },

  resultsContainer: {
    marginTop: 8,
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    maxHeight: 260,
    overflow: 'hidden',
  },
  searchingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
  },
  searchingText: {
    fontSize: 13,
    color: '#b3b3b3',
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#404040',
  },
  resultAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  resultAvatarPlaceholder: {
    backgroundColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultAvatarLetter: {
    fontSize: 12,
    color: '#b3b3b3',
    fontWeight: '600',
  },
  resultInfo: {
    flex: 1,
  },
  resultName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#f2f2f2',
  },
  resultAbout: {
    fontSize: 12,
    color: '#b3b3b3',
    marginTop: 1,
  },
});
