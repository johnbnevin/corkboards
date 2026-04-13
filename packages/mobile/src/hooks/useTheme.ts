import { type Theme } from '../lib/AppContext';
import { useAppContext } from './useAppContext';

/**
 * Hook to get and set the active theme.
 * Returns the stored theme preference, the resolved theme ('dark' | 'light'),
 * and a setter. Uses React Native's Appearance API when theme is 'system'.
 */
export function useTheme(): {
  theme: Theme;
  resolvedTheme: 'dark' | 'light';
  setTheme: (theme: Theme) => void;
} {
  const { config, updateConfig, resolvedTheme } = useAppContext();

  return {
    theme: config.theme,
    resolvedTheme,
    setTheme: (theme: Theme) => {
      updateConfig((currentConfig) => ({
        ...currentConfig,
        theme,
      }));
    },
  };
}
