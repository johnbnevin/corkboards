/**
 * ContentFilters -- Filter toggles for content types (emoji-only, media-only,
 * links-only, markdown, character count, exact text match, always-show exceptions).
 *
 * Port of packages/web/src/components/ContentFilters.tsx for React Native.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  Switch,
  StyleSheet,
} from 'react-native';

// ---- Types ----

export interface ContentFilterConfig {
  hideMinChars: number;
  hideOnlyEmoji: boolean;
  hideOnlyMedia: boolean;
  hideOnlyLinks: boolean;
  hideMarkdown: boolean;
  hideExactText: string;
  allowPV: boolean;
  allowGM: boolean;
  allowGN: boolean;
  allowEyes: boolean;
  allow100: boolean;
}

export type ContentFilterKey = keyof ContentFilterConfig;

interface ContentFiltersProps {
  config: ContentFilterConfig;
  onChange: (key: ContentFilterKey, value: number | boolean | string) => void;
  hasActiveFilters: boolean;
}

// ---- Toggle definitions ----

const HIDE_TOGGLES: ReadonlyArray<[keyof ContentFilterConfig, string]> = [
  ['hideOnlyEmoji', 'Only emojis'],
  ['hideOnlyMedia', 'Only media'],
  ['hideOnlyLinks', 'Only links'],
  ['hideMarkdown', 'Markdown'],
];

const ALLOW_TOGGLES: ReadonlyArray<[keyof ContentFilterConfig, string]> = [
  ['allowPV', 'PV'],
  ['allowGM', 'GM'],
  ['allowGN', 'GN'],
  ['allowEyes', '\u{1F440}'],
  ['allow100', '\u{1F4AF}'],
];

// ---- Component ----

export const ContentFilters = React.memo(function ContentFilters({
  config,
  onChange,
  hasActiveFilters,
}: ContentFiltersProps) {
  const [open, setOpen] = useState(false);

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.toggleHeader} onPress={() => setOpen(!open)}>
        <Text style={styles.chevron}>{open ? '\u25BC' : '\u25B6'}</Text>
        <Text style={styles.headerText}>Hide notes with:</Text>
        {hasActiveFilters && <Text style={styles.activeTag}>(active)</Text>}
      </TouchableOpacity>

      {open && (
        <View style={styles.body}>
          {/* Character count threshold */}
          <View style={styles.charRow}>
            <Text style={styles.label}>Hide posts with</Text>
            <TextInput
              style={styles.charInput}
              value={String(config.hideMinChars || 0)}
              onChangeText={v => onChange('hideMinChars', Math.max(0, Number(v) || 0))}
              keyboardType="number-pad"
              maxLength={3}
            />
            <Text style={styles.label}>or fewer characters</Text>
          </View>

          {/* Content type toggles */}
          <View style={styles.toggleRow}>
            {HIDE_TOGGLES.map(([key, label]) => (
              <TouchableOpacity
                key={key}
                style={styles.checkItem}
                onPress={() => onChange(key, !config[key])}
              >
                <View style={[styles.checkbox, config[key] as boolean && styles.checkboxChecked]}>
                  {config[key] as boolean && <Text style={styles.checkmark}>{'\u2713'}</Text>}
                </View>
                <Text style={styles.checkLabel}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Exact text match */}
          <View style={styles.charRow}>
            <Text style={styles.label}>This exact text:</Text>
            <TextInput
              style={styles.textInput}
              value={config.hideExactText}
              onChangeText={v => onChange('hideExactText', v)}
              placeholder=""
              placeholderTextColor="#666"
            />
          </View>

          {/* Always-show exceptions */}
          <View style={styles.allowSection}>
            <View style={styles.allowBorder} />
            <View style={styles.allowContent}>
              <Text style={styles.label}>... but always show:</Text>
              <View style={styles.toggleRow}>
                {ALLOW_TOGGLES.map(([key, label]) => (
                  <TouchableOpacity
                    key={key}
                    style={styles.checkItem}
                    onPress={() => onChange(key, !config[key])}
                  >
                    <View style={[styles.checkbox, config[key] as boolean && styles.checkboxChecked]}>
                      {config[key] as boolean && <Text style={styles.checkmark}>{'\u2713'}</Text>}
                    </View>
                    <Text style={styles.checkLabel}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    marginTop: 8,
    paddingHorizontal: 8,
  },
  toggleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  chevron: {
    fontSize: 10,
    color: '#b3b3b3',
  },
  headerText: {
    fontSize: 12,
    color: '#b3b3b3',
    fontWeight: '500',
  },
  activeTag: {
    fontSize: 12,
    color: '#a855f7',
    marginLeft: 4,
  },

  body: {
    marginTop: 8,
    gap: 10,
  },

  charRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  label: {
    fontSize: 12,
    color: '#b3b3b3',
  },
  charInput: {
    backgroundColor: '#2a2a2a',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    width: 48,
    textAlign: 'center',
    color: '#f2f2f2',
    fontSize: 12,
  },
  textInput: {
    backgroundColor: '#2a2a2a',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    flex: 1,
    maxWidth: 120,
    color: '#f2f2f2',
    fontSize: 12,
  },

  toggleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  checkItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  checkbox: {
    width: 14,
    height: 14,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: '#666',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: '#a855f7',
    borderColor: '#a855f7',
  },
  checkmark: {
    fontSize: 10,
    color: '#fff',
    fontWeight: '700',
  },
  checkLabel: {
    fontSize: 12,
    color: '#b3b3b3',
  },

  allowSection: {
    flexDirection: 'row',
    gap: 8,
  },
  allowBorder: {
    width: 2,
    backgroundColor: 'rgba(168, 85, 247, 0.3)',
    borderRadius: 1,
  },
  allowContent: {
    flex: 1,
    gap: 6,
  },
});
