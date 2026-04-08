import { memo } from 'react';
import { ChevronDown } from 'lucide-react';
import { usePlatformStorage } from '@/hooks/usePlatformStorage';
import { STORAGE_KEYS } from '@/lib/storageKeys';

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Toggle definitions ───────────────────────────────────────────────────────

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

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Content-based filter controls (character count, emoji-only, media-only, etc.).
 * Manages its own collapsed/expanded state via platform storage.
 */
export const ContentFilters = memo(function ContentFilters({
  config,
  onChange,
  hasActiveFilters,
}: ContentFiltersProps) {
  const [open, setOpen] = usePlatformStorage(STORAGE_KEYS.FILTERS_OPEN, false);

  return (
    <div className="mt-2 px-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-muted-foreground font-medium hover:text-foreground transition-colors cursor-pointer"
      >
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? '' : '-rotate-90'}`} />
        Hide notes with:
        {hasActiveFilters && <span className="text-purple-500 ml-1">(active)</span>}
      </button>

      {open && (
        <div className="mt-1.5 space-y-1.5">
          {/* Character count threshold */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground whitespace-nowrap">Hide posts with</label>
            <input
              type="number"
              min={0}
              max={500}
              value={config.hideMinChars}
              onChange={e => onChange('hideMinChars', Math.max(0, Number(e.target.value)))}
              placeholder="0"
              className="h-8 w-16 px-2 border rounded text-xs text-center"
            />
            <span className="text-xs text-muted-foreground">or fewer characters</span>
          </div>

          {/* Content type toggles */}
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {HIDE_TOGGLES.map(([key, label]) => (
              <label key={key} className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={config[key] as boolean}
                  onChange={e => onChange(key, e.target.checked)}
                  className="h-3 w-3 accent-primary cursor-pointer"
                />
                {label}
              </label>
            ))}
          </div>

          {/* Exact text match */}
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground whitespace-nowrap">This exact text:</label>
            <input
              type="text"
              value={config.hideExactText}
              onChange={e => onChange('hideExactText', e.target.value)}
              placeholder=""
              className="h-5 px-1.5 text-xs border rounded bg-background flex-1 max-w-[120px]"
            />
          </div>

          {/* Always-show exceptions */}
          <div className="flex flex-wrap gap-x-2.5 gap-y-1 pl-1 border-l-2 border-primary/30">
            <span className="text-xs text-muted-foreground">... but always show:</span>
            {ALLOW_TOGGLES.map(([key, label]) => (
              <label key={key} className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={config[key] as boolean}
                  onChange={e => onChange(key, e.target.checked)}
                  className="h-3 w-3 accent-primary cursor-pointer"
                />
                {label}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});
