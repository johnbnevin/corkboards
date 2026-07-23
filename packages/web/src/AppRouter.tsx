import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ScrollToTop } from "./components/ScrollToTop";
import { ProfileModalProvider } from "./components/ProfileModal";

import { MultiColumnClient } from "./pages/MultiColumnClient";
import { NIP19Page } from "./pages/NIP19Page";
import NotFound from "./pages/NotFound";

// NIP-17 private messages are lazy-loaded: the entire DM subsystem (DMProvider +
// the dm/* UI) stays out of the app's startup/critical path and only loads when
// the user actually navigates to /messages. Keeps the first paint lean and means
// nothing in the DM code can affect boot.
const MessagesRoute = lazy(() => import("./pages/MessagesRoute"));

export function AppRouter() {
  // Use Vite's BASE_URL for subdirectory deployments
  const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/'

  return (
    <BrowserRouter basename={basename} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ProfileModalProvider>
        <ScrollToTop />
        <Routes>
          <Route path="/" element={<MultiColumnClient />} />
          {/* Hashtag route - must be before NIP-19 catch-all */}
          <Route path="/t/:hashtag" element={<MultiColumnClient />} />
          {/* NIP-17 private messages (lazy) */}
          <Route path="/messages" element={<Suspense fallback={null}><MessagesRoute /></Suspense>} />
          {/* NIP-19 route for npub1, note1, naddr1, nevent1, nprofile1 */}
          <Route path="/:nip19" element={<NIP19Page />} />
          {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ProfileModalProvider>
    </BrowserRouter>
  );
}
export default AppRouter;
