// NOTE: This file should normally not be modified unless you are adding a new provider.
// To add new routes, edit the AppRouter.tsx file.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHead, UnheadProvider } from '@unhead/react/client';
import { InferSeoMetaPlugin } from '@unhead/addons';
import { Suspense } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import NostrProvider from '@/components/NostrProvider';
import { Toaster } from "@/components/ui/toaster";
import { GlobalLightbox } from "@/components/ui/lightbox";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NostrLoginProvider } from '@nostrify/react/login';
import { AppProvider } from '@/components/AppProvider';
import { AppConfig } from '@/contexts/AppContext';
import { FALLBACK_RELAYS } from '@/lib/relayConstants';
import { NwcProvider } from '@/hooks/useNwc';
import AppRouter from './AppRouter';

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
    relays: FALLBACK_RELAYS.map(url => ({ url, read: true, write: true })),
    updatedAt: 0,
  },
};

export function App() {
  return (
    <UnheadProvider head={head}>
      <AppProvider storageKey="corkboard:app-config" defaultConfig={defaultConfig}>
        <QueryClientProvider client={queryClient}>
          <NostrLoginProvider storageKey='corkboard:login'>
            <NostrProvider>
              <NwcProvider>
              <TooltipProvider>
                <Toaster />
                <GlobalLightbox />
                <ErrorBoundary>
                  <Suspense fallback={<div className="flex items-center justify-center h-screen" />}>
                    <AppRouter />
                  </Suspense>
                </ErrorBoundary>
              </TooltipProvider>
              </NwcProvider>
            </NostrProvider>
          </NostrLoginProvider>
        </QueryClientProvider>
      </AppProvider>
    </UnheadProvider>
  );
}

export default App;
