/**
 * Platform-specific signer/extension recommendations for Nostr login.
 * Mobile port of web's SignerRecommendations component.
 * Single source of truth for signer recommendations on mobile.
 */
import { Platform, View, Text, StyleSheet, Linking, TouchableOpacity } from 'react-native';

interface SignerRec {
  name: string;
  note: string;
  url?: string;
}

const MOBILE_SIGNERS: Record<string, SignerRec[]> = {
  iPhone: [
    { name: 'Alby Go', note: 'Nostr signer and Lightning wallet', url: 'https://apps.apple.com/us/app/alby-go/id6471335774' },
    { name: 'Nostur', note: 'Full Nostr client with built-in key management', url: 'https://apps.apple.com/us/app/nostur-nostr-client/id1672780508' },
  ],
  Android: [
    { name: 'Amber', note: 'Dedicated signer app — keys never leave the device (recommended)', url: 'https://play.google.com/store/apps/details?id=com.greenart7c3.nostrsigner' },
    { name: 'Amethyst', note: 'Full Nostr client with built-in key management', url: 'https://play.google.com/store/apps/details?id=com.vitorpamplona.amethyst' },
  ],
};

function detectPlatform(): string {
  return Platform.OS === 'ios' ? 'iPhone' : 'Android';
}

/** Get a short platform-aware recommendation string for messages. */
export function getSignerRecommendation(): string {
  const platform = detectPlatform();
  const signers = MOBILE_SIGNERS[platform];
  if (signers) {
    return `For ${platform}, try ${signers.map(s => s.name).join(' or ')}.`;
  }
  return 'Install a Nostr signer app for better key security.';
}

/** Get the top signer recommendation for the current platform. */
export function getTopSignerForPlatform(): { name: string; url?: string; platform: string } {
  const platform = detectPlatform();
  const signers = MOBILE_SIGNERS[platform];
  if (signers?.[0]) return { ...signers[0], platform };
  return { name: 'Amber', url: 'https://play.google.com/store/apps/details?id=com.greenart7c3.nostrsigner', platform };
}

interface SignerRecommendationsProps {
  variant?: 'full' | 'compact';
}

export function SignerRecommendations({ variant: _variant = 'full' }: SignerRecommendationsProps) {
  const platform = detectPlatform();

  const openLink = (url: string) => {
    Linking.openURL(url).catch(() => {});
  };

  const renderSection = (title: string, items: Record<string, SignerRec[]>, highlight?: string) => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {Object.entries(items).map(([plat, signers]) => (
        <View key={plat} style={styles.platformRow}>
          <Text style={[styles.platformText, plat === highlight && styles.platformHighlight]}>
            {plat === highlight ? '> ' : ''}{plat}:{' '}
          </Text>
          {signers.map((s, i) => (
            <Text key={s.name} style={[styles.signerText, plat === highlight && styles.platformHighlight]}>
              {i > 0 ? ', ' : ''}
              {s.url ? (
                <Text style={styles.signerLink} onPress={() => openLink(s.url!)}>{s.name}</Text>
              ) : (
                s.name
              )}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );

  return (
    <View style={styles.container}>
      {renderSection('Mobile', MOBILE_SIGNERS, platform)}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  section: { gap: 2 },
  sectionTitle: { color: '#f2f2f2', fontSize: 12, fontWeight: '600', marginBottom: 2 },
  platformRow: { flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 1 },
  platformText: { color: '#999', fontSize: 12 },
  platformHighlight: { color: '#f2f2f2', fontWeight: '500' },
  signerText: { color: '#999', fontSize: 12 },
  signerLink: { color: '#f97316', fontSize: 12, textDecorationLine: 'underline' },
});
