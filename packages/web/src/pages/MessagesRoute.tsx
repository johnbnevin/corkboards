import { DMProvider } from "@/components/DMProvider";
import Messages from "./Messages";

/**
 * Lazy entry point for the NIP-17 messages route — bundles DMProvider + the
 * Messages page into a single async chunk so the whole DM subsystem is loaded
 * only when the user visits /messages (see AppRouter).
 */
export default function MessagesRoute() {
  return (
    <DMProvider config={{ enabled: true }}>
      <Messages />
    </DMProvider>
  );
}
