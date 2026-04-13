/**
 * EditProfileForm — React Native form for editing Nostr profile metadata (kind 0).
 *
 * Mirrors packages/web/src/components/EditProfileForm.tsx.
 * Fields: display_name, name, about, picture, banner, website, nip05, lud16.
 */
import { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Alert,
  Image,
} from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/AuthContext';
import { useAuthor } from '../hooks/useAuthor';
import { useNostrPublish } from '../hooks/useNostrPublish';

interface ProfileFormData {
  display_name: string;
  name: string;
  about: string;
  picture: string;
  banner: string;
  website: string;
  nip05: string;
  lud16: string;
}

const EMPTY_FORM: ProfileFormData = {
  display_name: '',
  name: '',
  about: '',
  picture: '',
  banner: '',
  website: '',
  nip05: '',
  lud16: '',
};

interface EditProfileFormProps {
  onSaved?: () => void;
}

export function EditProfileForm({ onSaved }: EditProfileFormProps) {
  const { pubkey } = useAuth();
  const { data: authorData } = useAuthor(pubkey ?? undefined);
  const { mutateAsync: publish, isPending } = useNostrPublish();
  const queryClient = useQueryClient();

  const meta = authorData?.metadata;
  const [form, setForm] = useState<ProfileFormData>(EMPTY_FORM);

  // Populate form when metadata loads
  useEffect(() => {
    if (meta) {
      setForm({
        display_name: meta.display_name || '',
        name: meta.name || '',
        about: meta.about || '',
        picture: meta.picture || '',
        banner: meta.banner || '',
        website: meta.website || '',
        nip05: meta.nip05 || '',
        lud16: meta.lud16 || '',
      });
    }
  }, [meta]);

  const update = (field: keyof ProfileFormData, value: string) =>
    setForm(prev => ({ ...prev, [field]: value }));

  const handleSave = async () => {
    if (!pubkey) return;

    try {
      // Merge with existing metadata to preserve fields we don't edit
      const data: Record<string, string> = {};
      if (meta) {
        for (const [k, v] of Object.entries(meta)) {
          if (typeof v === 'string' && v) data[k] = v;
        }
      }

      // Overlay form values (empty strings = remove field)
      for (const [key, value] of Object.entries(form)) {
        const trimmed = value.trim();
        if (trimmed) {
          data[key] = trimmed;
        } else {
          delete data[key];
        }
      }

      await publish({
        kind: 0,
        content: JSON.stringify(data),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      });

      await queryClient.invalidateQueries({ queryKey: ['author', pubkey] });
      Alert.alert('Profile saved', 'Your profile has been published to Nostr relays.');
      onSaved?.();
    } catch (err) {
      Alert.alert('Failed to update profile', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const bannerUrl = form.banner.trim();
  const pictureUrl = form.picture.trim();

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      {/* Visual banner + avatar header */}
      <View style={styles.headerSection}>
        {/* Banner */}
        <View style={styles.bannerContainer}>
          {bannerUrl ? (
            <Image source={{ uri: bannerUrl }} style={styles.bannerImage} />
          ) : (
            <View style={styles.bannerPlaceholder}>
              <View style={styles.bannerSky} />
              <View style={styles.bannerHills} />
            </View>
          )}
        </View>

        {/* Avatar overlapping banner */}
        <View style={styles.avatarContainer}>
          {pictureUrl ? (
            <Image source={{ uri: pictureUrl }} style={styles.avatarImage} />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Text style={styles.avatarPlaceholderText}>?</Text>
            </View>
          )}
        </View>
      </View>

      <View style={styles.spacer} />

      {/* URL inputs for banner/avatar */}
      <View style={styles.row}>
        <View style={styles.halfField}>
          <Text style={styles.label}>Avatar URL</Text>
          <TextInput
            style={styles.input}
            value={form.picture}
            onChangeText={v => update('picture', v)}
            placeholder="https://..."
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        <View style={styles.halfField}>
          <Text style={styles.label}>Banner URL</Text>
          <TextInput
            style={styles.input}
            value={form.banner}
            onChangeText={v => update('banner', v)}
            placeholder="https://..."
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      </View>

      {/* Name fields */}
      <View style={styles.row}>
        <View style={styles.halfField}>
          <Text style={styles.label}>Display Name</Text>
          <TextInput
            style={styles.input}
            value={form.display_name}
            onChangeText={v => update('display_name', v)}
            placeholder="How you appear to others"
            placeholderTextColor="#666"
          />
        </View>
        <View style={styles.halfField}>
          <Text style={styles.label}>Username</Text>
          <TextInput
            style={styles.input}
            value={form.name}
            onChangeText={v => update('name', v)}
            placeholder="short_handle"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
      </View>

      {/* Bio */}
      <View style={styles.fieldRow}>
        <Text style={styles.label}>Bio</Text>
        <TextInput
          style={[styles.input, styles.textArea]}
          value={form.about}
          onChangeText={v => update('about', v)}
          placeholder="Tell others about yourself"
          placeholderTextColor="#666"
          multiline
          numberOfLines={3}
        />
      </View>

      {/* Identity & links */}
      <View style={styles.row}>
        <View style={styles.halfField}>
          <Text style={styles.label}>NIP-05</Text>
          <TextInput
            style={styles.input}
            value={form.nip05}
            onChangeText={v => update('nip05', v)}
            placeholder="you@example.com"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />
        </View>
        <View style={styles.halfField}>
          <Text style={styles.label}>Website</Text>
          <TextInput
            style={styles.input}
            value={form.website}
            onChangeText={v => update('website', v)}
            placeholder="https://..."
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>
      </View>

      {/* Lightning address */}
      <View style={styles.fieldRow}>
        <Text style={styles.label}>Lightning Address</Text>
        <TextInput
          style={styles.input}
          value={form.lud16}
          onChangeText={v => update('lud16', v)}
          placeholder="you@walletofsatoshi.com"
          placeholderTextColor="#666"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />
      </View>

      {/* Save button */}
      <TouchableOpacity
        style={[styles.saveButton, isPending && styles.buttonDisabled]}
        onPress={handleSave}
        disabled={isPending}
      >
        {isPending ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <Text style={styles.saveButtonText}>Save Profile</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1f1f1f' },
  scrollContent: { padding: 16, paddingBottom: 40 },

  // Header
  headerSection: { position: 'relative', marginBottom: 8 },
  bannerContainer: {
    width: '100%',
    height: 100,
    borderRadius: 10,
    overflow: 'hidden',
  },
  bannerImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  bannerPlaceholder: {
    width: '100%',
    height: '100%',
    position: 'relative',
    overflow: 'hidden',
  },
  bannerSky: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: '50%',
    backgroundColor: '#3b82f6',
  },
  bannerHills: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '50%',
    backgroundColor: '#16a34a',
    borderTopLeftRadius: 60,
    borderTopRightRadius: 60,
  },
  avatarContainer: {
    position: 'absolute',
    bottom: -24,
    left: 16,
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 3,
    borderColor: '#1f1f1f',
    overflow: 'hidden',
  },
  avatarImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  avatarPlaceholder: {
    width: '100%',
    height: '100%',
    backgroundColor: '#4b5563',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarPlaceholderText: { color: '#9ca3af', fontSize: 24, fontWeight: '600' },
  spacer: { height: 20 },

  // Form fields
  row: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  halfField: { flex: 1 },
  fieldRow: { marginBottom: 16 },
  label: {
    color: '#999',
    fontSize: 12,
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: '#2a2a2a',
    borderWidth: 1,
    borderColor: '#404040',
    borderRadius: 8,
    padding: 12,
    color: '#f2f2f2',
    fontSize: 14,
  },
  textArea: {
    minHeight: 80,
    textAlignVertical: 'top',
  },

  // Save
  saveButton: {
    backgroundColor: '#f97316',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.5 },
  saveButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
