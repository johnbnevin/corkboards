/**
 * ThroughputSettings — modal for independently tuning feed and bandwidth settings.
 *
 * Allows per-parameter control of: feed multiplier, autofetch interval,
 * avatar size limit, and image size limit.
 */

import { Label } from '@/components/ui/label';
import { AVATAR_SIZE_OPTIONS, IMAGE_SIZE_OPTIONS, type SizeLimitOption } from '@/hooks/useImageSizeLimit';
import type { FeedLimitMultiplier } from '@/hooks/useFeedLimit';

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
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(String(opt.value))}
            className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
              String(value) === String(opt.value)
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background border-border hover:bg-muted'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
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
    <div className="space-y-5">
      <OptionRow
        label="Feed load multiplier"
        options={[
          { value: 1, label: '1x — +25 / +100' },
          { value: 2, label: '2x — +50 / +200' },
          { value: 3, label: '3x — +75 / +300' },
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
    </div>
  );
}
