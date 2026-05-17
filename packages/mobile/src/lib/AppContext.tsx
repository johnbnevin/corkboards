/**
 * Mobile AppContext — centralized app config with MMKV persistence.
 * Mirrors web's AppContext.ts + AppProvider.tsx.
 */
import React, { createContext, useCallback, useMemo, useState, useEffect } from 'react';
import { Appearance } from 'react-native';
import { mobileStorage } from '../storage/MmkvStorage';

export type Theme = 'dark' | 'light' | 'system';

export interface RelayMetadata {
  /** List of relays with read/write permissions */
  relays: { url: string; read: boolean; write: boolean }[];
  /** Unix timestamp of when the relay list was last updated */
  updatedAt: number;
}

export interface AppConfig {
  /** Current theme */
  theme: Theme;
  /** NIP-65 relay list metadata */
  relayMetadata: RelayMetadata;
  /** Whether to include the ["client", "corkboards.me"] tag on published events (default: true) */
  publishClientTag?: boolean;
}

export interface AppContextType {
  /** Current application configuration */
  config: AppConfig;
  /** Update configuration using a callback that receives current config and returns new config */
  updateConfig: (updater: (currentConfig: Partial<AppConfig>) => Partial<AppConfig>) => void;
  /** Resolved theme — 'dark' or 'light' (never 'system') */
  resolvedTheme: 'dark' | 'light';
}

export const AppContext = createContext<AppContextType | undefined>(undefined);

const DEFAULT_CONFIG: AppConfig = {
  theme: 'system',
  relayMetadata: { relays: [], updatedAt: 0 },
  // Off by default — `client` tags are followable, which means a non-anon
  // sender's pubkey gets correlated to "uses corkboards" by relay observers
  // forever. Users can opt in via Advanced Settings. Matches the web default.
  publishClientTag: false,
};

const STORAGE_KEY = 'corkboard:app-config';

function loadConfig(): Partial<AppConfig> {
  try {
    const raw = mobileStorage.getSync(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Basic validation
      if (parsed && typeof parsed === 'object') {
        const result: Partial<AppConfig> = {};
        if (['dark', 'light', 'system'].includes(parsed.theme)) {
          result.theme = parsed.theme;
        }
        if (parsed.relayMetadata && Array.isArray(parsed.relayMetadata.relays)) {
          result.relayMetadata = parsed.relayMetadata;
        }
        if (typeof parsed.publishClientTag === 'boolean') {
          result.publishClientTag = parsed.publishClientTag;
        }
        return result;
      }
    }
  } catch { /* ignore corrupt data */ }
  return {};
}

function saveConfig(partial: Partial<AppConfig>) {
  mobileStorage.setSync(STORAGE_KEY, JSON.stringify(partial));
}

// Theme resolution (system → dark/light) is currently handled inside the
// React component tree rather than this helper. Kept commented for future
// use rather than deleted because the import of `Appearance` is referenced
// in other places this module re-exports.
// function resolveTheme(theme: Theme): 'dark' | 'light' { ... }

interface AppProviderProps {
  children: React.ReactNode;
}

export function AppProvider({ children }: AppProviderProps) {
  const [rawConfig, setRawConfig] = useState<Partial<AppConfig>>(loadConfig);
  const [systemColorScheme, setSystemColorScheme] = useState<'dark' | 'light'>(
    Appearance.getColorScheme() === 'dark' ? 'dark' : 'light',
  );

  // Listen for system theme changes
  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemColorScheme(colorScheme === 'dark' ? 'dark' : 'light');
    });
    return () => subscription.remove();
  }, []);

  const updateConfig = useCallback((updater: (currentConfig: Partial<AppConfig>) => Partial<AppConfig>) => {
    setRawConfig((prev) => {
      const next = updater(prev);
      saveConfig(next);
      return next;
    });
  }, []);

  const config = useMemo<AppConfig>(() => ({ ...DEFAULT_CONFIG, ...rawConfig }), [rawConfig]);

  const resolvedTheme = useMemo<'dark' | 'light'>(() => {
    if (config.theme === 'system') return systemColorScheme;
    return config.theme;
  }, [config.theme, systemColorScheme]);

  const value = useMemo<AppContextType>(() => ({
    config,
    updateConfig,
    resolvedTheme,
  }), [config, updateConfig, resolvedTheme]);

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}
