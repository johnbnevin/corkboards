/**
 * ThroughputSettings -- Settings for feed multiplier, autofetch interval,
 * avatar size limits, and image size limits.
 *
 * Port of packages/web/src/components/ThroughputSettings.tsx for React Native.
 */
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import {
  AVATAR_SIZE_OPTIONS,
  IMAGE_SIZE_OPTIONS,
  type SizeLimitOption,
} from '../hooks/useImageSizeLimit';
import type { FeedLimitMultiplier } from '../hooks/useFeedLimit';

interface ThroughputSettingsProps {
  multiplier: FeedLimitMultiplier;
  onMultiplierChange: (v: FeedLimitMultiplier) => void;
  autofetchIntervalSecs: number;
  onAutofetchIntervalChange: (v: number) => void;
  avatarSizeLimit: SizeLimitOption;
  onAvatarSizeLimitChange: (v: SizeLimitOption) => void;
  imageSizeLimit: SizeLimitOption;
  onImageSizeLimitChange: (v: SizeLimitOption) => void;
}

function OptionRow({ label, options, value, onChange }: {
  label: string;
  options: { value: string | number; label: string }[];
  value: string | number;
  onChange: (v: string) => void;
}) {
  return (
    <View style={styles.optionRow}>
      <Text style={styles.optionLabel}>{label}</Text>
      <View style={styles.optionButtons}>
        {options.map(opt => {
          const isActive = String(value) === String(opt.value);
          return (
            <TouchableOpacity
              key={opt.value}
              style={[styles.optionBtn, isActive && styles.optionBtnActive]}
              onPress={() => onChange(String(opt.value))}
            >
              <Text style={[styles.optionBtnText, isActive && styles.optionBtnTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

export function ThroughputSettings({
  multiplier,
  onMultiplierChange,
  autofetchIntervalSecs,
  onAutofetchIntervalChange,
  avatarSizeLimit,
  onAvatarSizeLimitChange,
  imageSizeLimit,
  onImageSizeLimitChange,
}: ThroughputSettingsProps) {
  return (
    <View style={styles.container}>
      <OptionRow
        label="Feed load multiplier"
        options={[
          { value: 1, label: '1x' },
          { value: 2, label: '2x' },
          { value: 3, label: '3x' },
        ]}
        value={multiplier}
        onChange={(v) => onMultiplierChange(Number(v) as FeedLimitMultiplier)}
      />

      <OptionRow
        label="Autofetch interval"
        options={[
          { value: 180, label: '3 min' },
          { value: 120, label: '2 min' },
          { value: 60, label: '1 min' },
        ]}
        value={autofetchIntervalSecs}
        onChange={(v) => onAutofetchIntervalChange(Number(v))}
      />

      <OptionRow
        label="Avatar file size max"
        options={AVATAR_SIZE_OPTIONS}
        value={avatarSizeLimit}
        onChange={(v) => onAvatarSizeLimitChange(v as SizeLimitOption)}
      />

      <OptionRow
        label="Image file size max"
        options={IMAGE_SIZE_OPTIONS}
        value={imageSizeLimit}
        onChange={(v) => onImageSizeLimitChange(v as SizeLimitOption)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 20,
  },
  optionRow: {
    gap: 8,
  },
  optionLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: '#b3b3b3',
  },
  optionButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#404040',
    backgroundColor: '#2a2a2a',
  },
  optionBtnActive: {
    backgroundColor: '#a855f7',
    borderColor: '#a855f7',
  },
  optionBtnText: {
    fontSize: 12,
    color: '#b3b3b3',
  },
  optionBtnTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
});
