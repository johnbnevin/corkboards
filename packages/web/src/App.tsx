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
import { AppConfig } from '@/contexts/AppContext';
import { NwcProvider } from '@/hooks/useNwc';
import { CollapsedNotesProvider } from '@/hooks/useCollapsedNotes';
import AppRouter from './AppRouter';
import { installDesktopLinkInterceptor } from '@/lib/openExternal';

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

  return (
    <UnheadProvider head={head}>
      <AppProvider storageKey="corkboard:app-config" defaultConfig={defaultConfig}>
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
