import { useContext } from 'react';
import { AppContext, type AppContextType } from '../lib/AppContext';

/**
 * Hook to access and update application configuration.
 * Must be used within an AppProvider.
 */
export function useAppContext(): AppContextType {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useAppContext must be used within an AppProvider');
  }
  return context;
}
