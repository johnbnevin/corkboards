// NOTE: This file should normally not be modified unless you are adding a new provider.
// To add new routes, edit the AppRouter.tsx file.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHead, UnheadProvider } from '@unhead/react/client';
import { InferSeoMetaPlugin } from '@unhead/addons';
import { Suspense, useEffect } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import NostrProvider from '@/components/NostrProvider';
import { Toaster } from "@/components/ui/toaster";
import { GlobalLightbox } from "@/components/ui/lightbox";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NostrLoginProvider } from '@nostrify/react/login';
import { AppProvider } from '@/components/AppProvider';
import { STORAGE_KEYS } from '@core/storageKeys';
import { AppConfig } from '@/contexts/AppContext';
import { NwcProvider } from '@/hooks/useNwc';
import { CollapsedNotesProvider } from '@/hooks/useCollapsedNotes';
import AppRouter from './AppRouter';
import { installDesktopLinkInterceptor } from '@/lib/openExternal';
import { KEYSTORE_WARNING_EVENT } from '@/lib/webKeyStore';
import { toast } from '@/hooks/useToast';
import { setBlossomServerListProvider } from '@core/blossom';
import { getBlossomServers } from '@/hooks/useNostrBackup';

// Render-time Blossom fallbacks must fan out to the servers the USER chose,
// not a hard-coded list — each candidate host learns the viewer's IP + blob
// hash on any media load failure. Module scope so it's set before first render.
setBlossomServerListProvider(getBlossomServers);

const head = createHead({
  plugins: [
    InferSeoMetaPlugin(),
  ],
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60000, // 1 minute
      gcTime: 10 * 60 * 1000, // 10 minutes — balanced between mobile background and memory pressure
    },
  },
});

const defaultConfig: AppConfig = {
  theme: "light",
  relayMetadata: {
    relays: [],
    updatedAt: 0,
  },
  // Off by default — the `client` tag is followable, so a non-anon sender's
  // pubkey gets correlated to "uses corkboards" by relay observers forever.
  // Users can opt in via Advanced Settings.
  publishClientTag: false,
};

export function App() {
  // Desktop only: route plain `<a href="http…">` clicks to the OS browser. The
  // webview can't open them itself, so without this every external link in the
  // app is inert (or, for untargeted anchors, navigates the app away from
  // itself). No-op in a normal browser.
  useEffect(() => installDesktopLinkInterceptor(), []);

  // Key-at-rest failures must be LOUD. When the encrypted key store (IDB) or
  // the OS keychain can't take the nsec, the app deliberately keeps the
  // plaintext so the account isn't lost — but a console.error was the only
  // signal, so users ran indefinitely with an unprotected key without knowing.
  useEffect(() => {
    const onWarning = (e: Event) => {
      const message = (e as CustomEvent<string>).detail || 'Key storage degraded — your signing key may be unprotected at rest.';
      toast({ title: 'Key storage warning', description: message, variant: 'destructive', duration: 30_000 });
    };
    window.addEventListener(KEYSTORE_WARNING_EVENT, onWarning);
    return () => window.removeEventListener(KEYSTORE_WARNING_EVENT, onWarning);
  }, []);

  return (
    <UnheadProvider head={head}>
      <AppProvider storageKey={STORAGE_KEYS.APP_CONFIG} defaultConfig={defaultConfig}>
        <QueryClientProvider client={queryClient}>
          <NostrLoginProvider storageKey='corkboard:login'>
            <NostrProvider>
              <NwcProvider>
                <ErrorBoundary>
                  <TooltipProvider>
                    <Toaster />
                    <GlobalLightbox />
                    <Suspense fallback={<div className="flex items-center justify-center h-screen" />}>
                      <CollapsedNotesProvider>
                        <AppRouter />
                      </CollapsedNotesProvider>
                    </Suspense>
                  </TooltipProvider>
                </ErrorBoundary>
              </NwcProvider>
            </NostrProvider>
          </NostrLoginProvider>
        </QueryClientProvider>
      </AppProvider>
    </UnheadProvider>
  );
}

export default App;
