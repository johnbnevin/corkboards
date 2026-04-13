/**
 * Security info modal — explains how login works on Nostr, key management best practices.
 * Mobile port of web's SecurityInfoDialog component.
 */
import { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ScrollView,
  Linking,
} from 'react-native';
import { SignerRecommendations } from './SignerRecommendations';

export function SecurityInfoDialog() {
  const [open, setOpen] = useState(false);

  const openLink = (url: string) => {
    Linking.openURL(url).catch(() => {});
  };

  return (
    <>
      <TouchableOpacity onPress={() => setOpen(true)}>
        <Text style={styles.trigger}>Security info</Text>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog}>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
              <View style={styles.header}>
                <Text style={styles.headerTitle}>How login works</Text>
              </View>

              {/* Simple intro */}
              <View style={styles.introBox}>
                <Text style={styles.introTitle}>New here? It's simple.</Text>
                <Text style={styles.bodyText}>
                  Just pick a name and hit Start — no email needed. You'll get a secret key
                  to save (like a master password), and that's it. You're in.
                </Text>
                <Text style={styles.italicNote}>
                  That's the easy way, and it works, but it is not the most secure way
                  to use Corkboards.
                </Text>
              </View>

              <Text style={styles.bodyText}>
                Saving the secret key to your password manager is as secure as a password
                on other sites, but if you are building a business or a personal profile
                you plan to keep around permanently, there are some things you should know.
              </Text>

              {/* How Corkboards is different */}
              <Text style={styles.sectionTitle}>How Corkboards is different</Text>
              <Text style={styles.bodyText}>
                Corkboards is built on a decentralized protocol called Nostr. You own your
                account. That means there are no central servers to stop you from posting,
                and it also means there are none to save your password for you.
              </Text>

              {/* Why key security matters */}
              <Text style={styles.sectionTitle}>Why key security matters</Text>
              <Text style={styles.bodyText}>
                Your secret key is your permanent, irrevocable identity. There is no
                password reset. If someone obtains your key, they become you — forever.
                Treat it like a Bitcoin private key, not a website password.
              </Text>

              {/* How we protect your key */}
              <Text style={styles.sectionTitle}>How we protect your key</Text>
              <Text style={styles.bodyText}>
                The Corkboards mobile app stores your key in the OS keychain (Keychain on iOS,
                Keystore on Android), which is hardware-backed and encrypted. For even stronger
                protection, use a dedicated signer app:
              </Text>

              {/* Signer recommendations */}
              <View style={styles.signerBox}>
                <Text style={styles.signerBoxTitle}>
                  Signer Apps — keys never leave the device
                </Text>
                <Text style={styles.bodyText}>
                  A signer app holds your key in a separate process, isolated from other apps.
                  Even if an app were compromised, the attacker gets signatures for one session —
                  not your permanent identity.
                </Text>
                <SignerRecommendations variant="compact" />
              </View>

              {/* Bunker / Remote signer */}
              <View style={styles.signerBox}>
                <Text style={styles.signerBoxTitle}>
                  Bunker / Remote Signer (NIP-46)
                </Text>
                <Text style={styles.bodyText}>
                  A remote signer keeps your key on a separate device entirely. The app
                  communicates with the signer over encrypted relay messages and only ever
                  receives signatures, never the key itself.
                </Text>
                <View style={styles.signerLinks}>
                  <Text style={styles.bodyText}>
                    <Text style={styles.bold}>Android: </Text>
                    <Text style={styles.link} onPress={() => openLink('https://play.google.com/store/apps/details?id=com.greenart7c3.nostrsigner')}>Amber</Text>
                    {' (dedicated signer)'}
                  </Text>
                  <Text style={styles.bodyText}>
                    <Text style={styles.bold}>iPhone: </Text>
                    <Text style={styles.link} onPress={() => openLink('https://apps.apple.com/us/app/alby-go/id6471335774')}>Alby Go</Text>
                    {', '}
                    <Text style={styles.link} onPress={() => openLink('https://apps.apple.com/us/app/nostur-nostr-client/id1672780508')}>Nostur</Text>
                  </Text>
                </View>
              </View>

              {/* No account, no server */}
              <Text style={styles.sectionTitle}>No account, no server</Text>
              <Text style={styles.bodyText}>
                Nostr has no accounts, emails, or passwords. Your secret key is your identity.
                There is no "forgot password" flow. Keep your key backed up securely — if you
                lose it, no one can recover it for you.
              </Text>

              <TouchableOpacity style={styles.closeBtn} onPress={() => setOpen(false)}>
                <Text style={styles.closeBtnText}>Close</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    color: '#999',
    fontSize: 12,
    textDecorationLine: 'underline',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  dialog: {
    backgroundColor: '#1f1f1f',
    borderRadius: 16,
    maxHeight: '85%',
    width: '100%',
    maxWidth: 400,
  },
  scrollContent: {
    padding: 20,
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  headerTitle: {
    color: '#f2f2f2',
    fontSize: 18,
    fontWeight: '700',
  },
  introBox: {
    backgroundColor: '#2a2a2a',
    borderWidth: 1,
    borderColor: '#404040',
    borderRadius: 8,
    padding: 14,
    gap: 8,
  },
  introTitle: {
    color: '#f2f2f2',
    fontSize: 14,
    fontWeight: '600',
  },
  bodyText: {
    color: '#b3b3b3',
    fontSize: 13,
    lineHeight: 19,
  },
  italicNote: {
    color: '#999',
    fontSize: 12,
    fontStyle: 'italic',
  },
  sectionTitle: {
    color: '#f2f2f2',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 4,
  },
  signerBox: {
    backgroundColor: '#1a2a1a',
    borderWidth: 1,
    borderColor: '#2a4a2a',
    borderRadius: 8,
    padding: 14,
    gap: 8,
  },
  signerBoxTitle: {
    color: '#4ade80',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  signerLinks: {
    gap: 4,
    marginTop: 4,
  },
  bold: {
    fontWeight: '600',
    color: '#f2f2f2',
  },
  link: {
    color: '#f97316',
    textDecorationLine: 'underline',
  },
  closeBtn: {
    backgroundColor: '#2a2a2a',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  closeBtnText: {
    color: '#f2f2f2',
    fontSize: 15,
    fontWeight: '600',
  },
});
