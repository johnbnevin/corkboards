import { useLocalStorage } from './useLocalStorage';
import { STORAGE_KEYS } from '@core/storageKeys';

export type SizeLimitOption = 'small' | 'default' | 'large' | 'none';

const AVATAR_LIMIT_BYTES: Record<SizeLimitOption, number> = {
  small:   250 * 1024,
  default: 750 * 1024,
  large:   1.5 * 1024 * 1024,
  none:    0,
};

const IMAGE_LIMIT_BYTES: Record<SizeLimitOption, number> = {
  small:   750 * 1024,
  default: 2.25 * 1024 * 1024,
  large:   4.5 * 1024 * 1024,
  none:    0,
};

export const AVATAR_SIZE_OPTIONS: { value: SizeLimitOption; label: string }[] = [
  { value: 'small',   label: '250 KB' },
  { value: 'default', label: '750 KB' },
  { value: 'large',   label: '1.5 MB' },
  { value: 'none',    label: 'No limit' },
];

export const IMAGE_SIZE_OPTIONS: { value: SizeLimitOption; label: string }[] = [
  { value: 'small',   label: '750 KB' },
  { value: 'default', label: '2.25 MB' },
  { value: 'large',   label: '4.5 MB' },
  { value: 'none',    label: 'No limit' },
];

export function useImageSizeLimitSetting() {
  return useLocalStorage<SizeLimitOption>(STORAGE_KEYS.IMAGE_SIZE_LIMIT, 'default');
}

export function useAvatarSizeLimitSetting() {
  return useLocalStorage<SizeLimitOption>(STORAGE_KEYS.AVATAR_SIZE_LIMIT, 'default');
}

export function useImageSizeLimit(): number {
  const [option] = useImageSizeLimitSetting();
  return IMAGE_LIMIT_BYTES[option] ?? IMAGE_LIMIT_BYTES.default;
}

export function useAvatarSizeLimit(): number {
  const [option] = useAvatarSizeLimitSetting();
  return AVATAR_LIMIT_BYTES[option] ?? AVATAR_LIMIT_BYTES.default;
}
