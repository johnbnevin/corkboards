import { useState, useEffect, useMemo, useCallback, useRef, useTransition, lazy, Suspense } from 'react';
import { RSS_PUBKEY } from '@core/rss';
import { parseFeedSource as parseFeedSourceCore } from '@core/feedSource';
import { useSeoMeta } from '@unhead/react';
import { useNavigate, useParams } from 'react-router-dom';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostr } from '@/hooks/useNostr';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useImageSizeLimitSetting, useAvatarSizeLimitSetting } from '@/hooks/useImageSizeLimit';
import { usePlatformStorage } from '@/hooks/usePlatformStorage';
import { useToast } from '@/hooks/useToast';
import { debugLog } from '@/lib/debug';

import { usePinnedNotes } from '@/hooks/usePinnedNotes';
import { useParentNotes } from '@/hooks/useParentNotes';
import { useDiscover } from '@/hooks/useDiscover';
import { useOnboardDiscover } from '@/hooks/useOnboardDiscover';
import { useOnboardFollowActivity } from '@/hooks/useOnboardFollowActivity';
import { OnboardSearchWidget } from '@/components/OnboardSearchWidget';
import { useFollowNotesCache } from '@/hooks/useFollowNotesCache';
import { useCustomFeedNotesCache } from '@/hooks/useCustomFeedNotesCache';
import { useRelayFeed } from '@/hooks/useRelayFeed';
import { useRssFeed } from '@/hooks/useRssFeed';
import { ToastBar, useFeedToast } from '@/components/ToastBar';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import { type NostrEvent } from '@nostrify/nostrify';
import { useContactActions } from '@/hooks/useContactActions';
import { useNip65Relays } from '@/hooks/useNip65Relays';
import { useIsMobile } from '@/hooks/useIsMobile';
import { classifyNote, type NoteClassification } from '@/lib/noteClassifier';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { HashtagActionContext } from '@/contexts/hashtagAction';
import { DeletedAuthorsContext } from '@/contexts/deletedAuthors';
import { BrandIcon } from '@/components/BrandIcon';
import { BrandLogo } from '@/components/BrandLogo';
import { useDeletedAuthors } from '@/hooks/useDeletedAuthors';
import { ProfileCard } from '@/components/ProfileCard';
import { ThreadPanel } from '@/components/thread'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { genUserName } from '@/lib/genUserName';
import { optimizeAvatarUrl } from '@/lib/imageUtils';
import type { KindFilter } from '@/components/NoteKindToggles';
import { ALL_NOTE_KIND_FILTERS } from '@/components/NoteKindToggles';
import type { ContentFilterConfig, ContentFilterKey } from '@/components/ContentFilters';
import {
  profileModalState,
  PROFILE_ACTION_NEW_CORKBOARD,
  PROFILE_ACTION_ADD_TO_CORKBOARD,
  PROFILE_ACTION_FOLLOW,
  PROFILE_ACTION_UNFOLLOW,
  PROFILE_ACTION_MUTE,
  type ProfileActionDetail,
} from '@/components/ProfileModal';
import { WelcomePage } from '@/components/auth/WelcomePage';
import { AccountSwitcher } from '@/components/auth/AccountSwitcher';
import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import { useLoginActions } from '@/hooks/useLoginActions';
import { useMuteList } from '@/hooks/useMuteList';
import { useFollowSets } from '@/hooks/useFollowSets';
// Preload + retry: fetch the chunk immediately so it's cached before the user clicks compose.
// If the initial fetch fails (offline, slow network), retry once on demand.
const composeImport = import('@/components/ComposeDialog').catch(() => null);
const ComposeDialog = lazy(async () => {
  const cached = await composeImport;
  if (cached) return { default: cached.ComposeDialog };
  // Retry once — covers transient network blips
  const fresh = await import('@/components/ComposeDialog');
  return { default: fresh.ComposeDialog };
});
import { PenSquare, Settings, Sun, Moon, Wallet, UserPlus, UserCheck, LogOut, Pin, Download, Upload, Trash2, HardDrive, CloudUpload, Volume2, Smile, Loader2, SlidersHorizontal, Wifi, Server, ScanLine } from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';
import { useAppContext } from '@/hooks/useAppContext';
import { useRelayHealth } from '@/hooks/useRelayHealth';
import { useUnresolvedRetry } from '@/hooks/useUnresolvedRetry';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from '@/components/ui/dropdown-menu';
import { useCollapsedNotes, BOOKMARK_SYNC_EVENT } from '@/hooks/useCollapsedNotes';
import { useNotificationCount } from '@/hooks/useNotificationCount';
import { useBookmarks } from '@/hooks/useBookmarks';
import { ZapDialog } from '@/components/ZapDialog';
// Lazy — the QR scanner (jsQR) and its camera UI aren't needed until the user
// opens scan-to-zap, so keep them out of the initial chunk.
const ScanToZapDialog = lazy(() => import('@/components/ScanToZapDialog').then(m => ({ default: m.ScanToZapDialog })));
import { WalletSettings } from '@/components/WalletSettings';
import { EditProfileForm } from '@/components/EditProfileForm';
import { ProfileCacheSettings } from '@/components/ProfileCacheSettings';
import { ThroughputSettings } from '@/components/ThroughputSettings';
// Lazy — the Advanced settings panel (relay/Blossom managers) and the emoji-set
// editor (emoji picker + data) are opened rarely and on explicit action, so defer
// their chunks past first paint.
const AdvancedSettings = lazy(() => import('@/components/AdvancedSettings').then(m => ({ default: m.AdvancedSettings })));
const EmojiSetEditor = lazy(() => import('@/components/EmojiSetEditor').then(m => ({ default: m.EmojiSetEditor })));
import { useNostrBackup, getBlossomServers, setBlossomServers, getBlossomServersUpdatedAt, setBlossomServersUpdatedAt, DEFAULT_BLOSSOM_SERVERS } from '@/hooks/useNostrBackup';
import { PROFILE_INDEXER_RELAYS } from '@core/relayConstants';
import { MAX_RETAINED_NOTES } from '@core/feedConstants';
import { bumpQueryEpoch, getQueryEpoch, withQueryBudget, StaleEpochError } from '@core/queryGovernor';
import { registerBackupFlush } from '@/lib/backupFlush';
import { getOnboarded, setOnboarded, clearOnboarded, idbReady as onboardIdbReady } from '@/lib/onboardingFlag';
import { STORAGE_KEYS } from '@/lib/storageKeys';
import { useAccountIsolation } from '@/hooks/useAccountIsolation';
import { useAutoRestoreGuard } from '@/hooks/useAutoRestoreGuard';
import { useScrollPersistence } from '@/hooks/useScrollPersistence';
import { useCloudSync } from '@/hooks/useCloudSync';
import { useKeychainHealth } from '@/hooks/useKeychainHealth';
import { useAutoFetch } from '@/hooks/useAutoFetch';
import { useAccountSwitchEffect } from '@/hooks/useAccountSwitchEffect';
import { useBulkAuthorPrefetch } from '@/hooks/useBulkAuthorPrefetch';
import { useAutoRestoreCountdown } from '@/hooks/useAutoRestoreCountdown';
import { useAutoSaveTrigger } from '@/hooks/useAutoSaveTrigger';
import { idbGetSync, idbSetSync, idbReady } from '@/lib/idb';
import { getCachedProfiles, setCachedProfiles, getProfilesNeedingRefresh, markProfileRefreshed } from '@/lib/profileCache';

import { TIPS } from '@/lib/tips';
import { BackupSplashScreen } from '@/components/BackupSplashScreen';
import { BackupDownloadPrompt } from '@/components/BackupDownloadPrompt';
import { downloadSettingsBackup, shouldPromptBackupDownload, restoreFromBackupFile, preflightRestore, saveCheckpoint } from '@/lib/downloadBackup';
import { FEED_KINDS } from '@/lib/feedUtils';
// NostrProvider relay utilities used by components but no longer needed in this file
import { getCacheStatsForPubkeys } from '@/lib/notesCache';
import { getUserRelays } from '@/components/NostrProvider';
import { useFeedLimit } from '@/hooks/useFeedLimit';
import { useFeedPagination } from '@/hooks/useFeedPagination';
import { FeedGrid } from '@/components/FeedGrid';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { FeedInfoCard } from '@/components/FeedInfoCard';
import { getNoteCategories, noteMatchesHashtags, noteMatchesKindFilters, computeHashtagCounts, computeNoteKindStats } from '@core/noteCategories';
import { noteMatchesContentFilters, hasActiveContentFilters as hasActiveContentFiltersFor } from '@core/contentFilters';
import { getCachedEvent } from '@/lib/fetchEvent';
import { StatusBar } from '@/components/StatusBar';
import { TabBar } from '@/components/TabBar';
import { NotificationsCorkboard } from '@/components/NotificationsCorkboard';
import { playConsolidateSound, previewConsolidateSound } from '@/lib/consolidateSound';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';



// Feed utilities imported from feedUtils above

/** Notes we ask for engagement on. Kept near a screenful — every extra id
 *  changes the query key and forces a fresh network round trip. */
/** Profiles fetched per follows page. Also the window `hasMoreFollows` compares against. */
const FOLLOWS_BATCH_SIZE = 500;

const LAZY_ENGAGEMENT_TARGETS = 60;
/** Ceiling on engagement events pulled per round (was 500 — see the query). */
const LAZY_ENGAGEMENT_LIMIT = 150;

// Content-filter regexes now live in @core/contentFilters, next to the predicate
// that uses them, so web and mobile evaluate identical rules.
const AUTO_SAVE_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes after page load — prevents overwriting good backup with empty state

// Estimate note height for column balancing

/** Confirmation dialog for "Pin to my corkboard" with optional comment */
function PinToBoardDialog({
  note,
  open,
  onClose,
  onPin,
  onPinWithComment,
  isAlreadyPinned,
}: {
  note: NostrEvent | null;
  open: boolean;
  onClose: () => void;
  onPin: () => void;
  onPinWithComment: () => void;
  isAlreadyPinned?: boolean;
}) {
  const [addComment, setAddComment] = useState(!!isAlreadyPinned);

  // Reset checkbox when dialog opens with new note
  useEffect(() => {
    if (open) setAddComment(!!isAlreadyPinned);
  }, [open, isAlreadyPinned]);

  const title = isAlreadyPinned ? 'Re-pin to my corkboard' : 'Pin to my corkboard';
  const buttonLabel = addComment
    ? (isAlreadyPinned ? 'Write comment & re-pin' : 'Write comment & pin')
    : (isAlreadyPinned ? 'Re-pin to board' : 'Pin to board');

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pin className="h-5 w-5" />
            {title}
          </DialogTitle>
        </DialogHeader>
        {note && (
          <>
            <div className="p-3 bg-muted/50 rounded-lg max-h-48 overflow-y-auto">
              <p className="text-sm line-clamp-4">{note.content.slice(0, 300)}{note.content.length > 300 && '...'}</p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox checked={addComment} onCheckedChange={(v) => setAddComment(!!v)} />
              <span className="text-sm">Add a comment</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button
                onClick={addComment ? onPinWithComment : onPin}
                className="bg-orange-500 hover:bg-orange-600 gap-1.5"
              >
                <Pin className="h-4 w-4" />
                {buttonLabel}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function MultiColumnClient() {
  useSeoMeta({
    title: 'corkboards.me',
    description: 'A private social feed reader and builder',
    // `keywords` was dropped from UseSeoMetaInput in @unhead/react v3 — set it via meta name="keywords" if needed
  });

  // Profile fetch is deferred — enabled after canLoadNotes is set (below)
  const [profileFetchEnabled, setProfileFetchEnabled] = useState(false);
  const { user, metadata: authorMetadata } = useCurrentUser(profileFetchEnabled);
  const { currentUser, otherUsers, logins: allLogins, setLogin: switchToAccount } = useLoggedInAccounts();
  const loginActions = useLoginActions();
  const { mutedPubkeys, mute: mutePubkey } = useMuteList(profileFetchEnabled);
  const { lists: followSets, isLoading: isLoadingFollowSets } = useFollowSets(profileFetchEnabled);
  // Prefer useAuthor metadata (has profile cache) over useLoggedInAccounts (short timeout)
  const loggedInPicture = authorMetadata?.picture || currentUser?.metadata?.picture;
  const loggedInName = authorMetadata?.display_name || authorMetadata?.name || currentUser?.metadata?.name;
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { mutate: createEvent } = useNostrPublish();
  const { toast } = useToast();
  const feedToastMessages = useFeedToast();
  const { fetchRelaysForPubkey, fetchRelaysForMultiple } = useNip65Relays();
  const isMobile = useIsMobile();
  const { limit: baseFeedLimit, multiplier: feedLimitMultiplier, setMultiplier: setFeedLimitMultiplier } = useFeedLimit();

  // Request persistent storage so browsers don't evict localStorage/IDB when
  // the tab is backgrounded or the device is low on space. Without this, the
  // backup-checked flag can disappear, causing the backup splash to reappear.
  useEffect(() => {
    if (user?.pubkey && navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {});
    }
  }, [user?.pubkey]);

  // Desktop: a signing key missing from the OS keychain makes every publish,
  // reaction, zap and backup fail with no explanation (see useKeychainHealth).
  // Say so once, plainly, instead of letting the user discover it as "the app
  // is broken". Not auto-dismissed — this needs a decision, not a glance.
  const { missingKeyPubkeys } = useKeychainHealth();
  const warnedMissingKeysRef = useRef('');
  useEffect(() => {
    const signature = missingKeyPubkeys.join(',');
    if (!signature || warnedMissingKeysRef.current === signature) return;
    warnedMissingKeysRef.current = signature;
    toast({
      title: 'Signing key missing from your keychain',
      description:
        missingKeyPubkeys.length === 1
          ? 'Corkboards can’t find this account’s key in the OS keychain, so posting, reacting, zapping and backup will all fail. If your keyring is locked, unlock it and restart. Otherwise log out and log back in with your nsec to restore it.'
          : `${missingKeyPubkeys.length} accounts have no key in the OS keychain. Posting, reacting, zapping and backup will fail for them. Unlock your keyring and restart, or log in again with each nsec.`,
      variant: 'destructive',
      duration: Infinity,
    });
  }, [missingKeyPubkeys, toast]);

  // Per-user isolation: extracted into a focused hook so the bug-prone
  // account-switch flow can be tested independently and future fixes are
  // less likely to regress. See useAccountIsolation.ts.
  useAccountIsolation(user?.pubkey);
  const [activeTab, setActiveTabRaw] = useState(() => {
    const saved = sessionStorage.getItem('corkboard:active-tab');
    if (saved) return saved;
    // New users go straight to discover
    if (sessionStorage.getItem('corkboard:new-user')) return 'discover';
    return 'me';
  });
  // Optimistic tab: updates instantly for visual feedback while content re-renders
  const [optimisticTab, setOptimisticTab] = useState(activeTab);
  const [isTabPending, startTabTransition] = useTransition();
  // True once the user (or a deep link) has picked a tab this session — used to
  // avoid the cold-start restore below clobbering a deliberate navigation.
  const userChoseTabRef = useRef(false);
  // "Back to top" indicator — lifted up so useScrollPersistence can drive it.
  const [scrolledFromTop, setScrolledFromTop] = useState(false);
  // Scroll persistence: per-tab position saved to sessionStorage, restored on
  // tab switch, page reload, and visibility-return. Extracted from inline
  // effects so the retry/poll logic can be unit-tested independently.
  const { onTabChange: onTabChangeScroll } =
    useScrollPersistence({ activeTab, onScrolledFromTopChange: setScrolledFromTop });
  // Flag to suppress scroll-to-note after tab switch (so autofetch doesn't override)
  const suppressScrollTargetUntil = useRef(0);
  const setActiveTab = useCallback((tab: string) => {
    userChoseTabRef.current = true;
    // Discard relay work queued for the tab we're leaving.
    //
    // Nothing used to cancel it, so clicking three tabs in quick succession
    // stacked three complete fan-outs — feed query, profile prefetch, parent
    // lookups, engagement — and only the last tab's results were ever shown.
    // The other two still paid for every TLS handshake and every signature
    // check. Bumping the epoch drops anything still QUEUED (it never runs);
    // already-open sockets are left to finish, since abandoning a handshake
    // mid-flight wastes the work without giving the CPU back.
    bumpQueryEpoch();
    // Suppress scroll targets for 2s after tab switch so autofetch doesn't override
    suppressScrollTargetUntil.current = Date.now() + 2000;
    // Fast, same-session copy for in-tab reloads…
    sessionStorage.setItem('corkboard:active-tab', tab);
    // …and a durable, per-user copy (IDB, isolated + backed up) so a full app
    // relaunch after idle restores the last-viewed tab instead of dropping to 'me'.
    idbSetSync(STORAGE_KEYS.ACTIVE_TAB, tab);
    setOptimisticTab(tab);
    if (tab === 'notifications') markNotificationsSeen();
    // Wrap heavy state update in transition so content re-renders in background
    startTabTransition(() => {
      setActiveTabRaw(tab);
    });
    // Hand off save+restore of scroll positions to the dedicated hook.
    onTabChangeScroll(tab);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- markNotificationsSeen declared after this hook (forward ref)
  }, [startTabTransition, onTabChangeScroll]);

  // Cold-start tab restore. sessionStorage is wiped when the OS/PWA evicts the
  // app during idle, so on a full relaunch the initializer above sees an empty
  // session and lands on 'me'. The durable per-user ACTIVE_TAB key (IDB) holds
  // the real last-viewed tab, but IDB's sync cache is empty until idbReady, so
  // we can only read it after mount and correct the tab then. Skipped when the
  // session already had a tab (in-tab reload), for new users, or once the user
  // has navigated — so this never fights a deliberate choice.
  useEffect(() => {
    if (sessionStorage.getItem('corkboard:active-tab')) return;
    if (sessionStorage.getItem('corkboard:new-user')) return;
    let cancelled = false;
    (async () => {
      await idbReady;
      if (cancelled || userChoseTabRef.current) return;
      const durable = idbGetSync(STORAGE_KEYS.ACTIVE_TAB);
      if (durable && durable !== 'me' && !userChoseTabRef.current) {
        setActiveTab(durable);
      }
    })();
    return () => { cancelled = true; };
    // mount-only; setActiveTab is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [defaultColumnCount, _setDefaultColumnCount] = usePlatformStorage<number>(STORAGE_KEYS.DEFAULT_COLUMN_COUNT, 3);
  const [featuresModalOpen, setFeaturesModalOpen] = useState(false);
  const [addAccountDialogOpen, setAddAccountDialogOpen] = useState(false);
  // Detect newly-added accounts and ensure user.pubkey moves so useAccountIsolation
  // can do the storage swap + reload. Extracted into useAccountSwitchEffect.
  useAccountSwitchEffect({
    allLogins,
    pubkey: user?.pubkey,
    switchToAccount,
    onAccountAdded: () => setAddAccountDialogOpen(false),
  });
  // scrolledFromTop declared above (lifted up for useScrollPersistence callback)
  // Mobile account menu auto-close after 4s
  const [mobileAccountOpen, setMobileAccountOpen] = useState(false);
  const mobileAccountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (mobileAccountOpen) {
      mobileAccountTimerRef.current = setTimeout(() => setMobileAccountOpen(false), 4000);
    }
    return () => { if (mobileAccountTimerRef.current) clearTimeout(mobileAccountTimerRef.current); };
  }, [mobileAccountOpen]);

  // Track if we've prefetched on first login (to avoid doing it multiple times)
  const _hasPrefetchedRef = useRef(false);

  // Column count for current tab (synced from derived settings in useEffect below)
  // Default to 1 on mobile, but allow user to override (saved per-tab)
  const [columnCount, setColumnCount] = useState(() => {
    const savedDefault = localStorage.getItem('corkboard:default-column-count');
    const defaultCount = savedDefault ? parseInt(savedDefault, 10) : 3;
    return window.innerWidth < 768 ? 1 : defaultCount;
  });

  // Scale feed limit by column count on mobile so each column gets ~25 notes
  const feedLimit = isMobile ? baseFeedLimit * columnCount : baseFeedLimit;

  // Autofetch & media: global defaults (per-tab overrides applied later via currentTabSettings)
  const [autofetchLarge] = usePlatformStorage(STORAGE_KEYS.AUTOFETCH, false);
  const [autofetchSmall] = usePlatformStorage(STORAGE_KEYS.AUTOFETCH_SMALL, false);
  const [loadAllMediaLarge] = usePlatformStorage(STORAGE_KEYS.LOAD_ALL_MEDIA, false);
  const [loadAllMediaSmall] = usePlatformStorage(STORAGE_KEYS.LOAD_ALL_MEDIA_SMALL, false);
  const isSmallScreenNow = typeof window !== 'undefined' && window.innerWidth < 768;
  // Auto sub-options: global defaults (per-tab overrides below)
  const [_autoConsolidate] = usePlatformStorage(STORAGE_KEYS.AUTO_CONSOLIDATE, false);
  const [_autoScrollTop] = usePlatformStorage(STORAGE_KEYS.AUTO_SCROLL_TOP, false);
  // Per-tab autofetch/media/consolidate/scrollTop are derived after currentTabSettings (see below)
  const [publicBookmarks, setPublicBookmarks] = useLocalStorage(STORAGE_KEYS.PUBLIC_BOOKMARKS, false);
  const autofetchRef = useRef(false);

  // Settings file restore
  const settingsFileRef = useRef<HTMLInputElement | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{ json: string; warnings: string[] } | null>(null);
  const executeFileRestore = useCallback(async (json: string) => {
    try {
      // Save current state as a checkpoint before overwriting
      saveCheckpoint('file', 'Before file restore');
      // restoreFromBackupFile awaits all IDB writes and dispatches sync events
      // so useLocalStorage, useBookmarks, usePinnedNotes all pick up new values
      const count = await restoreFromBackupFile(json);
      toast({ title: `Restored ${count} settings` });
    } catch {
      toast({ title: 'Restore failed', variant: 'destructive' });
    }
  }, [toast]);

  const handleSettingsRestore = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = reader.result as string;
        const preflight = preflightRestore(json);

        if (preflight.warnings.length > 0) {
          const msgs = preflight.warnings.map(w => `${w.field}: ${w.incoming} (was ${w.current})`);
          setPendingRestore({ json, warnings: msgs });
        } else {
          executeFileRestore(json);
        }
      } catch {
        toast({ title: 'Invalid backup file', variant: 'destructive' });
      }
      if (settingsFileRef.current) settingsFileRef.current.value = '';
    };
    reader.readAsText(file);
  }, [toast, executeFileRestore]);

  const confirmPendingRestore = useCallback(() => {
    if (!pendingRestore) return;
    setPendingRestore(null);
    executeFileRestore(pendingRestore.json);
  }, [pendingRestore, executeFileRestore]);

  // Check if this account was previously deleted (kind 5 targeting own kind 0)
  const [deletedPubkey, setDeletedPubkey] = useState<string | null>(null);
  useEffect(() => {
    if (!user?.pubkey || !nostr) return;
    const controller = new AbortController();
    (async () => {
      try {
        const events = await nostr.query(
          [{ kinds: [5], authors: [user.pubkey], limit: 10 }],
          { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]) },
        );
        const hasProfileDeletion = events.some(e =>
          e.tags.some(t => t[0] === 'a' && t[1]?.startsWith(`0:${user.pubkey}`))
        );
        if (hasProfileDeletion) setDeletedPubkey(user.pubkey);
      } catch { /* timeout or abort — ignore */ }
    })();
    return () => controller.abort();
  }, [user?.pubkey, nostr]);
  const accountDeleted = deletedPubkey === user?.pubkey;

  // Delete account (vanish request — NIP-09 kind 5 for all profile events)
  const [showVanishConfirm, setShowVanishConfirm] = useState(false);
  const [vanishStep, setVanishStep] = useState(1); // 1 = first confirm, 2 = second confirm
  const [vanishing, setVanishing] = useState(false);
  const handleVanish = useCallback(async () => {
    if (!user) return;
    setVanishing(true);
    try {
      const now = Math.floor(Date.now() / 1000);
      // Publish kind 5 deletion requests for profile, contacts, relay list, backup, and custom sync events
      // Replaceable events (0, 3, 10002) use empty d-tag; addressable events need their actual d-tag
      const deletionTargets: Array<{ kind: number; dTag?: string }> = [
        { kind: 0 }, { kind: 3 }, { kind: 10002 },
        { kind: 30078, dTag: 'corkboard:backup' },
        { kind: 35571, dTag: 'corkboard:feeds' },
        { kind: 35572, dTag: 'corkboard:dismissed' },
      ];
      for (const { kind, dTag } of deletionTargets) {
        try {
          const aTag = `${kind}:${user.pubkey}:${dTag || ''}`;
          const event = await user.signer.signEvent({
            kind: 5, content: 'Account deleted by owner',
            tags: [['a', aTag]],
            created_at: now,
          });
          await nostr.event(event);
        } catch { /* best effort */ }
      }
      toast({ title: 'Vanish requests sent', description: 'Deletion requests published to relays. Logging out...' });
      setShowVanishConfirm(false);
      setVanishing(false);
      setVanishStep(1);
      // Wipe immediately without autosaving — the account is deleted, don't re-upload backup
      setTimeout(async () => {
        await loginActions.nuclearWipe();
        window.location.replace('/');
      }, 1500);
    } catch {
      toast({ title: 'Vanish failed', variant: 'destructive' });
      setVanishing(false);
    }
  }, [user, nostr, loginActions, toast]);

  // Checkpoints (Blossom backups)
  const [checkpointToRestoreIdx, setCheckpointToRestoreIdx] = useState<number | null>(null);

  // Local file backup modal
  const [localBackupOpen, setLocalBackupOpen] = useState(false);

  // Thread modal
  // Persist the note being read so a reload (SW picking up a new build, or a
  // mobile/tab eviction) reopens it instead of dropping the user back to the
  // feed. sessionStorage survives a same-tab reload; cleared when the thread is
  // closed so we only restore a thread that was actually open on return.
  const OPEN_THREAD_KEY = 'corkboard:open-thread';
  const [threadEventId, setThreadEventId] = useState<string | null>(() => {
    try { return sessionStorage.getItem(OPEN_THREAD_KEY) || null; } catch { return null; }
  });
  const [isThreadModalOpen, setIsThreadModalOpen] = useState<boolean>(() => {
    try { return !!sessionStorage.getItem(OPEN_THREAD_KEY); } catch { return false; }
  });
  // When set, auto-open reply compose after the thread loads
  const autoReplyNoteRef = useRef<NostrEvent | null>(null);

  const openThread = (eventId: string) => {
    autoReplyNoteRef.current = null;
    try { sessionStorage.setItem(OPEN_THREAD_KEY, eventId); } catch { /* sessionStorage unavailable */ }
    setThreadEventId(eventId);
    setIsThreadModalOpen(true);
  };

  const openThreadAndReply = useCallback((note: NostrEvent) => {
    autoReplyNoteRef.current = note;
    try { sessionStorage.setItem(OPEN_THREAD_KEY, note.id); } catch { /* sessionStorage unavailable */ }
    setThreadEventId(note.id);
    setIsThreadModalOpen(true);
  }, []);

  // Delete corkboard confirmation state
  const [deleteFeedId, setDeleteFeedId] = useState<string | null>(null);
  // Public bookmarks confirmation modal
  const [showPublicBookmarksConfirm, setShowPublicBookmarksConfirm] = useState(false);

  // Compose dialog state
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [composeReplyTo, setComposeReplyTo] = useState<NostrEvent | null>(null);
  const [composeQuotedEvent, setComposeQuotedEvent] = useState<NostrEvent | null>(null);
  const [composeRepostEvent, setComposeRepostEvent] = useState<NostrEvent | null>(null);

  // Extra notes for "me" tab loaded by loadMoreByCount (stored in state so memo reacts to them)
  // Defined early so handleComposePublished can add newly published notes
  const [extraUserNotes, setExtraUserNotes] = useState<NostrEvent[]>([]);

  const openCompose = useCallback(() => {
    setComposeReplyTo(null);
    setComposeQuotedEvent(null);
    setComposeRepostEvent(null);
    pinAfterPublishRef.current = null;
    setIsComposeOpen(true);
  }, []);

  // Store the thread refresh callback to call after posting (can pass new event)
  const threadRefreshRef = useRef<((newEvent?: NostrEvent) => void) | null>(null);
  // When set, pin this note after the compose dialog publishes (for "pin to board with comment")
  const pinAfterPublishRef = useRef<(() => void) | null>(null);

  const _openReply = useCallback((event: NostrEvent, refreshThread?: (newEvent?: NostrEvent) => void) => {
    setComposeReplyTo(event);
    setComposeQuotedEvent(null);
    setComposeRepostEvent(null);
    pinAfterPublishRef.current = null;
    threadRefreshRef.current = refreshThread || null;
    setIsComposeOpen(true);
  }, []);

  const openQuote = useCallback((event: NostrEvent, refreshThread?: (newEvent?: NostrEvent) => void) => {
    setComposeReplyTo(null);
    setComposeQuotedEvent(event);
    setComposeRepostEvent(null);
    pinAfterPublishRef.current = null;
    threadRefreshRef.current = refreshThread || null;
    setIsComposeOpen(true);
  }, []);

  const openRepost = useCallback((event: NostrEvent, refreshThread?: (newEvent?: NostrEvent) => void) => {
    setComposeReplyTo(null);
    setComposeQuotedEvent(null);
    setComposeRepostEvent(event);
    pinAfterPublishRef.current = null;
    threadRefreshRef.current = refreshThread || null;
    setIsComposeOpen(true);
  }, []);

  // Switch from repost confirmation to quote compose (repost with comment)
  const handleRepostWithComment = useCallback((event: NostrEvent) => {
    setComposeRepostEvent(null);
    setComposeQuotedEvent(event);
    pinAfterPublishRef.current = null;
  }, []);

  const closeCompose = useCallback(() => {
    setIsComposeOpen(false);
    setComposeReplyTo(null);
    setComposeQuotedEvent(null);
    setComposeRepostEvent(null);
    threadRefreshRef.current = null;
    pinAfterPublishRef.current = null;
  }, []);

  // Called when compose dialog successfully publishes
  const handleComposePublished = useCallback((newEvent: NostrEvent) => {
    // Capture the callback now - the ref will be cleared when dialog closes
    const refreshCallback = threadRefreshRef.current;
    if (refreshCallback) {
      // Small delay to let relays propagate the event
      setTimeout(() => {
        refreshCallback(newEvent);
      }, 300);
    }

    // "Pin to board with comment" — pin the original note after the quote is published
    if (pinAfterPublishRef.current) {
      pinAfterPublishRef.current();
      pinAfterPublishRef.current = null;
    }

     // Optimistically insert published notes (replies, reposts, top-level) so they appear instantly
     // in both the "me" tab and other tabs when "show my notes" is enabled
     if (user?.pubkey && newEvent.pubkey === user.pubkey) {
       setExtraUserNotes(prev => [newEvent, ...prev.filter(e => e.id !== newEvent.id)]);
       // Also update the user-notes cache for pagination anchoring
       queryClient.setQueryData<NostrEvent[]>(
         ['user-notes', user.pubkey],
         (old) => old ? [newEvent, ...old] : [newEvent],
       );
       // Inject into follow-notes-cache so it appears immediately in "all follows"
       queryClient.setQueriesData<NostrEvent[]>(
         { queryKey: ['follow-notes-cache'] },
         (old) => old ? [newEvent, ...old.filter(e => e.id !== newEvent.id)] : [newEvent],
       );
       // Persist to IndexedDB so it survives page refresh
       import('@/lib/notesCache').then(({ mergeNotesToCache }) => {
         mergeNotesToCache([newEvent]);
       });
     }
   }, [user?.pubkey, queryClient]);

  // Optimistically insert reactions into feed caches so they appear on all tabs immediately
  const handleReactionPublished = useCallback((event: NostrEvent) => {
    if (user?.pubkey && event.pubkey === user.pubkey) {
      setExtraUserNotes(prev => [event, ...prev.filter(e => e.id !== event.id)]);
      queryClient.setQueryData<NostrEvent[]>(
        ['user-notes', user.pubkey],
        (old) => old ? [event, ...old] : [event],
      );
      queryClient.setQueriesData<NostrEvent[]>(
        { queryKey: ['follow-notes-cache'] },
        (old) => old ? [event, ...old.filter(e => e.id !== event.id)] : [event],
      );
    }
  }, [user?.pubkey, queryClient]);

  // Feed builder dialog state
  const [showAddFriendDialog, setShowAddFriendDialog] = useState(false);
  const [newFriendInput, setNewFriendInput] = useState('');
  const [availableFollows, setAvailableFollows] = useState<{pubkey: string, name: string, picture?: string}[]>([]);
  const [allFollowsData, setAllFollowsData] = useState<{pubkey: string, name: string, picture?: string}[]>([]);
  const [editingFeedId, setEditingFeedId] = useState<string | null>(null);
  const [followsOffset, setFollowsOffset] = useState(0);
  const [isLoadingMoreFollows, setIsLoadingMoreFollows] = useState(false);

  // Zap dialog state
  const [zapTargetNote, setZapTargetNote] = useState<NostrEvent | null>(null);
  const [walletSettingsOpen, setWalletSettingsOpen] = useState(false);
  const [scanToZapOpen, setScanToZapOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [profileCacheSettingsOpen, setProfileCacheSettingsOpen] = useState(false);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [advancedSection, setAdvancedSection] = useState<'main' | 'relays' | 'blossom'>('main');
  const [emojiSetsOpen, setEmojiSetsOpen] = useState(false);
  // Stable callbacks so FeedGrid's React.memo (its heavy props — columns,
  // engagement — are already memoized) isn't defeated by a fresh function
  // identity on every parent render. Without these, an unrelated re-render (a
  // StatusBar timer tick, a filter toggle) re-runs the entire feed body.
  const noopCallback = useCallback(() => {}, []);
  const handleOpenEmojiSets = useCallback(() => setEmojiSetsOpen(true), []);
  const handleZapClick = useCallback((note: NostrEvent) => setZapTargetNote(note), []);
  const handleRepostClick = useCallback((note: NostrEvent) => openRepost(note), [openRepost]);
  const [consolidateSound, setConsolidateSoundRaw] = useLocalStorage<string>('corkboard:consolidate-sound', 'solitaire');
  const [soundAccelerate, setSoundAccelerate] = useLocalStorage<boolean>('corkboard:sound-accelerate', false);
  const [collapseReactions, setCollapseReactions] = useLocalStorage<boolean>('corkboard:collapse-reactions', true);
  const [renderMarkdown, setRenderMarkdown] = useLocalStorage<boolean>('corkboard:render-markdown', true);
  /** Play 3 sound previews — starts slow, graduates faster (like a consolidate ramping up) */
  const previewSound = useCallback((style: string) => {
    void previewConsolidateSound(style);
  }, []);
  const setConsolidateSound = useCallback((val: string) => {
    setConsolidateSoundRaw(val);
    previewSound(val);
  }, [setConsolidateSoundRaw, previewSound]);
  const [imageSizeLimit, setImageSizeLimit] = useImageSizeLimitSetting();
  const [avatarSizeLimit, setAvatarSizeLimit] = useAvatarSizeLimitSetting();
  const [autofetchIntervalSecs, setAutofetchIntervalSecs] = useLocalStorage<number>(STORAGE_KEYS.AUTOFETCH_INTERVAL_SECS, 120);
  const [customSettingsOpen, setCustomSettingsOpen] = useState(false);

  // Throughput presets: 1x/2x/3x set all bandwidth params together
  const THROUGHPUT_PRESETS = {
    1: { multiplier: 1 as const, interval: 180, avatar: 'small' as const, image: 'small' as const },
    2: { multiplier: 2 as const, interval: 120, avatar: 'default' as const, image: 'default' as const },
    3: { multiplier: 3 as const, interval: 60, avatar: 'large' as const, image: 'large' as const },
  };
  const activeThroughputPreset = ([1, 2, 3] as const).find(k => {
    const p = THROUGHPUT_PRESETS[k];
    return feedLimitMultiplier === p.multiplier && autofetchIntervalSecs === p.interval
      && avatarSizeLimit === p.avatar && imageSizeLimit === p.image;
  }) ?? null;
  const applyThroughputPreset = (tier: 1 | 2 | 3) => {
    const p = THROUGHPUT_PRESETS[tier];
    setFeedLimitMultiplier(p.multiplier);
    setAutofetchIntervalSecs(p.interval);
    setAvatarSizeLimit(p.avatar);
    setImageSizeLimit(p.image);
  };

  const [tabBarCollapsed, setTabBarCollapsed] = useLocalStorage<boolean>('corkboard:tab-bar-collapsed', false);
  const [stickyTabBar, setStickyTabBar] = useLocalStorage<boolean>('corkboard:sticky-tab-bar', true);

  // Profile/info card collapse state (shared with ProfileCard component)
  const [isInfoCollapsed, setIsInfoCollapsed] = usePlatformStorage<boolean>(STORAGE_KEYS.PROFILE_CARD_COLLAPSED, false);

  // Filter panel collapse state - default closed on mobile, open on desktop
  const [isFiltersCollapsed, setIsFiltersCollapsed] = useLocalStorage<boolean>('filter-panel-collapsed', isMobile);

  // Collapsed notes management
  const { dismissedCount, isDismissed, isCollapsedThisSession, isSoftDismissed, consolidate: rawConsolidate, clearDismissed, undismissMany, dismissedIds, collapsedCount: _collapsedCount, collapsedIds, dismiss, dismissMultiple, dismissThreadRoots, dismissedThreadRootSet } = useCollapsedNotes();

  // Restore only the dismissed notes the user authored. The dismissed store keeps
  // just event IDs, so we ask relays which of them are ours in one batched query
  // ({ ids, authors:[me] } AND-matches id-set with our pubkey) and un-dismiss only
  // those — no per-note fetch, no stored-shape change, works on existing data.
  const restoreOwnDismissed = useCallback(async () => {
    if (!user?.pubkey || dismissedIds.length === 0) return;
    toast({ title: 'Finding your dismissed notes…' });
    const own: string[] = [];
    const CHUNK = 200;
    for (let i = 0; i < dismissedIds.length; i += CHUNK) {
      const chunk = dismissedIds.slice(i, i + CHUNK);
      try {
        const events = await nostr.query(
          [{ ids: chunk, authors: [user.pubkey] }],
          { signal: AbortSignal.timeout(6000) },
        );
        for (const e of events) own.push(e.id);
      } catch { /* ignore this chunk */ }
    }
    if (own.length > 0) {
      undismissMany(own);
      toast({ title: `Restored ${own.length} of your note${own.length === 1 ? '' : 's'}` });
    } else {
      toast({ title: 'No dismissed notes of yours found', description: "None of your dismissed notes could be found on your relays." });
    }
  }, [user?.pubkey, dismissedIds, nostr, undismissMany, toast]);
  const { newCount: newNotificationCount, markSeen: markNotificationsSeen } = useNotificationCount();

  // NIP-51 bookmarks (kind 10003) — syncs with collapsed notes
  const { bookmarkIds, addBookmark, removeBookmark, republishBookmarks } = useBookmarks(true);

  // Listen for collapsed note toggles and sync to bookmarks
  useEffect(() => {
    const handler = (e: Event) => {
      const { noteId, action } = (e as CustomEvent).detail;
      if (action === 'add') addBookmark(noteId);
      else removeBookmark(noteId);
    };
    window.addEventListener(BOOKMARK_SYNC_EVENT, handler);
    return () => window.removeEventListener(BOOKMARK_SYNC_EVENT, handler);
  }, [addBookmark, removeBookmark]);

  // Nostr backup/restore
  const { backupStatus, backupCheckSettled, backupMessage, remoteBackup, loadRemoteBackup, dismissRemoteBackup, saveBackup, autoSaveBackup, downloadBackupAsFile, checkRemoteBackup, lastBackupTs, hasUnsavedChanges, checkpoints, getCheckpoints: _getCheckpoints, loadCheckpoint: loadCheckpointFn, logs: backupLogs, scanOlderStates, isScanning } = useNostrBackup(user, nostr);

  // Startup diagnostic log — emits once per user session
  useEffect(() => {
    if (!user?.pubkey) {
      debugLog(`[startup] No user — showing login screen`);
      return;
    }
    const { read, write } = getUserRelays();
    debugLog(`[startup] user=${user.pubkey.slice(0, 8)} readRelays=${read.length}(${read.join(',')}) writeRelays=${write.length}(${write.join(',')})`);
  }, [user?.pubkey]);

  // Logout: visible step-by-step — autosave to :auto slot, wipe, reload
  const [logoutStep, setLogoutStep] = useState<string | null>(null);
  const [logoutLog, setLogoutLog] = useState<string[]>([]);
  const [logoutTipIndex, setLogoutTipIndex] = useState(() => Math.floor(Math.random() * TIPS.length));
  useEffect(() => {
    if (!logoutStep) return;
    const timer = setInterval(() => {
      setLogoutTipIndex(prev => (prev + 1) % TIPS.length);
    }, 5000);
    return () => clearInterval(timer);
  }, [logoutStep]);
  const logLogout = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setLogoutLog(prev => [...prev, `[${ts}] ${msg}`]);
    setLogoutStep(msg);
  }, []);
  const [showLogoutSaveWarning, setShowLogoutSaveWarning] = useState(false);

  const doLogout = useCallback(async () => {
    if (!user?.pubkey) return;
    setShowLogoutSaveWarning(false);
    setLogoutStep('Preparing logout...');
    const forceReload = setTimeout(() => window.location.reload(), 20000);

    if (otherUsers.length > 0) {
      try {
        await loginActions.logoutAccount(user.pubkey);
        clearTimeout(forceReload);
        switchToAccount(otherUsers[0].id);
      } catch (e) {
        logLogout('Logout error: ' + (e instanceof Error ? e.message : String(e)));
        clearTimeout(forceReload);
        window.location.reload();
      }
    } else {
      try {
        await loginActions.nuclearWipe(logLogout);
        logLogout('done');
        await new Promise(r => setTimeout(r, 600));
      } catch (e) {
        logLogout('Wipe error: ' + (e instanceof Error ? e.message : String(e)));
      }
      clearTimeout(forceReload);
      window.location.reload();
    }
  }, [user?.pubkey, otherUsers, loginActions, logLogout, switchToAccount]);

  const handleLogout = useCallback(async () => {
    if (!user?.pubkey) return;
    setLogoutLog([]);
    setLogoutStep('Preparing logout...');
    const forceReload = setTimeout(() => window.location.reload(), 20000);

    // Save unsaved backup changes before logging out
    try {
      if (hasUnsavedChanges()) {
        logLogout('Unsaved changes detected. Saving backup...');
        const result = await autoSaveBackup();
        if (result === 'saved') {
          logLogout('Backup saved to Blossom.');
        } else if (result === 'skipped') {
          logLogout('No new changes needed saving.');
        } else {
          const reason = result === 'no-servers'
            ? 'Could not reach any Blossom server'
            : 'Backup save error';
          const lastTs = lastBackupTs;
          if (lastTs) {
            const ago = Math.round((Date.now() / 1000 - lastTs) / 60);
            logLogout(`${reason}. Last saved ${ago < 1 ? 'just now' : `${ago}m ago`}.`);
          } else {
            logLogout(`${reason}. No previous backup found.`);
          }
          logLogout('Continuing with logout...');
        }
      } else {
        logLogout('No unsaved changes — skipping backup.');
      }
    } catch (e) {
      logLogout('Backup error: ' + (e instanceof Error ? e.message : String(e)));
      logLogout('Continuing with logout...');
    }

    // Single-account logout: remove only this account, switch to next if any
    if (otherUsers.length > 0) {
      logLogout('Logging out active account...');
      try {
        await loginActions.logoutAccount(user.pubkey);
        logLogout('Switching to next account...');
        // Switch to the next account (triggers reload internally)
        clearTimeout(forceReload);
        switchToAccount(otherUsers[0].id);
      } catch (e) {
        logLogout('Logout error: ' + (e instanceof Error ? e.message : String(e)));
        clearTimeout(forceReload);
        window.location.reload();
      }
    } else {
      // Last account — full nuclear wipe
      try {
        await loginActions.nuclearWipe(logLogout);
        logLogout('done');
        await new Promise(r => setTimeout(r, 600));
      } catch (e) {
        logLogout('Wipe error: ' + (e instanceof Error ? e.message : String(e)));
      }
      clearTimeout(forceReload);
      window.location.reload();
    }
  }, [user?.pubkey, otherUsers, autoSaveBackup, loginActions, hasUnsavedChanges, lastBackupTs, logLogout, switchToAccount]);

  // Expose the backup flush to the account-switch choke point so switching
  // accounts (header switcher / mobile menu) flushes pending cloud backup for
  // the departing account first — parity with logout's safety.
  useEffect(() => {
    registerBackupFlush(async () => { if (hasUnsavedChanges()) { await autoSaveBackup(); } });
    return () => registerBackupFlush(null);
  }, [hasUnsavedChanges, autoSaveBackup]);


  const _backupTs = lastBackupTs; // read so React re-renders after saves
  const hasChanges = user ? hasUnsavedChanges() : false;

  // Wait for the single login check to settle before loading notes.
  // Once settled (or after restore), load everything.
  const canLoadNotes = !!user && backupCheckSettled && backupStatus !== 'restoring';
  useEffect(() => { if (canLoadNotes) setProfileFetchEnabled(true); }, [canLoadNotes]);


  // Auto-restore best checkpoint when login check finds backups — extracted
  // into a focused hook so the safety logic (never clobber live local data)
  // can't be accidentally bypassed by future refactors.
  useAutoRestoreGuard({
    backupCheckSettled,
    backupStatus,
    checkpoints,
    lastBackupTs,
    loadCheckpoint: loadCheckpointFn,
  });

  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [showBackupConfirm, setShowBackupConfirm] = useState(false);
  const [backupIndicator, setBackupIndicator] = useState<'idle' | 'unsaved' | 'saved'>('idle');
  const [showDownloadPrompt, setShowDownloadPrompt] = useState(false);

  // Prompt to download settings backup every 30 days
  const hasCheckedDownloadPrompt = useRef(false);
  useEffect(() => {
    if (user && !hasCheckedDownloadPrompt.current) {
      hasCheckedDownloadPrompt.current = true;
      if (shouldPromptBackupDownload()) {
        setTimeout(() => setShowDownloadPrompt(true), 2000);
      }
    }
  }, [user]);

  // Track whether the first login splash has resolved. Used below to decide
  // whether to remount the splash on subsequent backupStatus transitions.
  const initialLoginDoneRef = useRef(false);

  // Auto-save orchestration — extracted into useAutoSaveTrigger so the
  // three safety gates (page-load cooldown, inter-save min, change-detection
  // debounce) are co-located and unit-testable. See the hook for details.
  useAutoSaveTrigger({
    enabled: !!user && backupCheckSettled,
    backupStatus,
    lastBackupTs: lastBackupTs ?? 0,
    hasUnsavedChanges,
    autoSaveBackup,
    setBackupIndicator,
    toast,
    cooldownMs: AUTO_SAVE_COOLDOWN_MS,
  });

  // Cross-device sync. Checks on load, on return to the foreground, and on an
  // interval, and merges whenever the cloud is NEWER — not when it happens to
  // have more dismissed notes than we do.
  //
  // The old rule (useIdleAutoRestoreCheck: 5+ minutes idle AND 5+ more
  // dismissed) was a proxy for "is it safe to overwrite local with this",
  // because restore was an overwrite. It is a merge now, so the only question
  // left is which state is newer. A merge that would REMOVE something local
  // still isn't applied silently — it leaves the restore prompt standing.
  const [autoRestoreTarget, setAutoRestoreTarget] = useState<{ checkpoint: typeof checkpoints[0]; reason: string } | null>(null);
  useCloudSync({
    enabled: !!user,
    backupStatus,
    checkRemoteBackup,
    remoteTimestamp: remoteBackup?.timestamp ?? null,
    lastBackupTs,
    loadRemoteBackup,
  });

  // Visible 5-second countdown then auto-fire the restore — extracted hook
  // owns both the countdown state and the elapsed-callback to keep the auto-
  // restore safety logic colocated.
  const { countdown: autoRestoreCountdown } = useAutoRestoreCountdown({
    target: autoRestoreTarget,
    onElapsed: (t) => loadCheckpointFn(t.checkpoint),
    clearTarget: () => setAutoRestoreTarget(null),
  });

  // Theme management
  const { theme, setTheme } = useTheme();
  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  // App config (for settings like publishClientTag)
  const { config: appConfig, updateConfig } = useAppContext();

  // On login, refresh the user's own Nostr lists from relays and reconcile them
  // into local state (newer-wins), so relay changes made on other clients show up
  // instead of a stale cached/backup-restored copy:
  //   • NIP-65 relay list (kind 10002) → config.relayMetadata
  //   • Blossom server list (kind 10063) → stored blossom servers
  // Both fall back to the profile indexers (purplepag.es, …) which hold these
  // replaceable lists for ~everyone, so a fresh device still finds them.
  /** Attempts to fetch the user's kind-10002 before giving up for this session. */
  const NIP65_SYNC_ATTEMPTS = 4;
  const nip65SyncDone = useRef(false);
  useEffect(() => {
    if (!canLoadNotes || !user || nip65SyncDone.current) return;
    nip65SyncDone.current = true;
    const pubkey = user.pubkey;

    // Fetch the newest replaceable event of `kind` for the user — default pool
    // first, then the profile indexers. Returns null on miss/error.
    const fetchLatest = async (kind: number): Promise<NostrEvent | null> => {
      try {
        let events = await nostr.query(
          [{ kinds: [kind], authors: [pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(5000) },
        );
        if (events.length === 0) {
          events = await Promise.any(
            PROFILE_INDEXER_RELAYS.map(async (url) => {
              const evs = await nostr.relay(url).query(
                [{ kinds: [kind], authors: [pubkey], limit: 1 }],
                { signal: AbortSignal.timeout(4000) },
              );
              if (evs.length === 0) throw new Error('none');
              return evs;
            }),
          ).catch(() => [] as NostrEvent[]);
        }
        return events.length > 0 ? events[0] : null;
      } catch { return null; }
    };

    (async () => {
      // ── Relay list (kind 10002) ──
      //
      // Retried, because this runs ONCE per session and everything downstream
      // depends on it. A single transient miss — one fallback relay returning
      // 503 while another times out, which is an ordinary Tuesday — used to
      // leave `relayMetadata.relays` empty for the whole session. With no
      // relay list the outbox router has nothing to route to, so it falls back
      // to the hardcoded bootstrap set for EVERYTHING: profiles resolve as
      // `user_xxxxxxxx`, nested/quoted notes never arrive, "load more" returns
      // nothing, and Settings truthfully reports no relays while the health
      // check happily shows the fallbacks as 9/9 healthy. The symptom looks
      // like a broken app; the cause is one failed query nobody retried.
      //
      // Only a genuinely resolved outcome ends the loop: adopting a list, or
      // finding one that isn't newer than what we already have.
      for (let attempt = 0; attempt < NIP65_SYNC_ATTEMPTS; attempt++) {
        try {
          const ev = await fetchLatest(10002);
          if (ev) {
            if (ev.created_at > appConfig.relayMetadata.updatedAt) {
              const relays = ev.tags
                .filter(([name]) => name === 'r')
                .map(([, url, marker]) => ({
                  url,
                  read: !marker || marker === 'read',
                  write: !marker || marker === 'write',
                }));
              if (relays.length > 0) {
                updateConfig((current) => ({
                  ...current,
                  relayMetadata: { relays, updatedAt: ev.created_at },
                }));
                break;
              }
            } else {
              break; // ours is already current
            }
          }
        } catch { /* fall through to the retry delay */ }
        // Linear backoff — the relays that just failed are usually back within
        // seconds, and this runs while the feed is already rendering.
        if (attempt < NIP65_SYNC_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        }
      }

      // ── Blossom server list (kind 10063) ──
      try {
        const ev = await fetchLatest(10063);
        if (ev && ev.created_at > getBlossomServersUpdatedAt()) {
          const servers = ev.tags
            .filter((t) => t[0] === 'server' && t[1])
            .map((t) => (t[1].endsWith('/') ? t[1] : t[1] + '/'))
            .filter((url) => { try { return new URL(url).protocol === 'https:'; } catch { return false; } });
          if (servers.length > 0) {
            // User's servers first, then defaults as fallbacks (matches the
            // Settings persistence model and keeps backup redundancy).
            const merged = [...new Set([...servers, ...DEFAULT_BLOSSOM_SERVERS])];
            // Only rewrite when the list actually differs, to avoid a spurious
            // change event on every login.
            if (JSON.stringify(merged) !== JSON.stringify(getBlossomServers())) {
              setBlossomServers(merged);
            }
            setBlossomServersUpdatedAt(ev.created_at);
          }
        }
      } catch { /* best-effort */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once after login settles
  }, [canLoadNotes]);

  // Relay health — manual only, triggered from settings menu
  const { relayHealth: _relayHealth, checkAllRelays: _checkAllRelays, activeRelays: _activeRelays } = useRelayHealth();

  // Retry references that are on screen and unresolved — on a 30s cadence and
  // on every fetch of new notes (see the loadNewer wrapper below). Both go
  // through one scheduler so the two triggers can't overlap.
  const { sweep: sweepUnresolved } = useUnresolvedRetry();



  // Relay health checks are manual-only — triggered from the settings menu.
  // No automatic checks on mount to avoid unnecessary relay connections.

  // Per-tab filter settings type (complete set of all filter state for a tab)
  interface TabFilterSettings {
    columnCount?: number;     // per-tab column preference for large screens (1-9)
    columnCountSmall?: number; // per-tab column preference for small screens (1-9)
    hideMinChars?: number;
    hideOnlyEmoji?: boolean;
    allowPV?: boolean;
    allowGM?: boolean;
    allowGN?: boolean;
    allowEyes?: boolean;
    allow100?: boolean;
    hideOnlyMedia?: boolean;
    hideOnlyLinks?: boolean;
    hideHtml?: boolean;
    hideMarkdown?: boolean;
    hideExactText?: string;
    kindFilters?: string[];    // persisted kind filter toggles (e.g. ['posts','replies'])
    filterMode?: 'any' | 'strict'; // 'any' = show if any category on; 'strict' = hide if any category off
    hashtagFilters?: string[]; // persisted hashtag filter selections
    showOwnNotes?: boolean;    // whether to interleave user's own notes
    showPinned?: boolean;      // show pinned notes on me tab (default true)
    showUnpinned?: boolean;    // show unpinned notes on me tab (default true)
    autofetch?: boolean;       // auto-fetch newer notes periodically
    autofetchSmall?: boolean;  // autofetch for small screens
    autoConsolidate?: boolean; // auto-consolidate blank spaces after new notes
    autoScrollTop?: boolean;   // scroll to top when new notes arrive
    loadAllMedia?: boolean;    // load all images/videos (large screens)
    loadAllMediaSmall?: boolean; // load all media (small screens)
  }

  // Unified per-tab filter settings storage (for built-in tabs: me, all-follows, discover, relays, rss)
  // Custom feeds store their filterSettings on the CustomFeed object instead
  const [_tabFilters, setTabFilters] = useLocalStorage<Record<string, TabFilterSettings>>('corkboard:tab-filters', {});

  // Browsable relays (shown as tabs)
  const [browseRelays, setBrowseRelays] = useLocalStorage<string[]>('nostr-browse-relays', []);

  // RSS feeds (shown as tabs)
  const [rssFeeds, setRssFeeds] = useLocalStorage<string[]>('nostr-rss-feeds', []);

  // Custom feeds (pubkeys + relays + RSS + filters)
  interface CustomFeed {
    id: string;
    title: string;
    pubkeys: string[];
    relays: string[];
    rssUrls: string[];
    hashtags?: string[];   // hashtag sources (e.g. ['bitcoin', 'nostr'])
    columnCount?: number;  // per-corkboard column preference (deprecated - now in filterSettings)
    // Per-corkboard filter settings (unified - all filter state in one place)
    filterSettings?: TabFilterSettings;
  }
  const [customFeeds, setCustomFeeds] = useLocalStorage<CustomFeed[]>('nostr-custom-feeds', []);

  // Hashtag → "open in a new corkboard?" prompt. NoteContent (deeply nested)
  // requests this via HashtagActionContext; we hold the pending tag and, on
  // confirm, create (or reuse) a hashtag-filtered corkboard and switch to it.
  const [hashtagPrompt, setHashtagPrompt] = useState<string | null>(null);
  const hashtagActionValue = useMemo(() => ({
    onHashtagClick: (tag: string) => setHashtagPrompt(tag.replace(/^#/, '').toLowerCase()),
  }), []);
  const confirmOpenHashtagFeed = useCallback((tag: string) => {
    const norm = tag.replace(/^#/, '').toLowerCase();
    // Reuse an existing single-hashtag corkboard for this tag instead of piling up dupes.
    const existing = customFeeds.find(f =>
      (f.hashtags?.length === 1) && f.hashtags[0] === norm &&
      f.pubkeys.length === 0 && f.rssUrls.length === 0,
    );
    if (existing) {
      setActiveTab(`feed:${existing.id}`);
      toast({ title: `Opened #${norm}` });
      return;
    }
    const newFeed: CustomFeed = {
      id: Date.now().toString(),
      title: `#${norm}`,
      pubkeys: [],
      relays: [],
      rssUrls: [],
      hashtags: [norm],
    };
    setCustomFeeds(prev => [...prev, newFeed]);
    setActiveTab(`feed:${newFeed.id}`);
    toast({ title: 'Corkboard created', description: `New corkboard for #${norm}` });
  }, [customFeeds, setCustomFeeds, setActiveTab, toast]);

  // ─── /t/:hashtag deep link ────────────────────────────────────────────────
  // The route rendered this component but nothing read the param, so a shared
  // /t/bitcoin link silently dropped the user on their default feed. Open (or
  // reuse) the hashtag corkboard, then replace the URL with "/" so a refresh
  // or a later back-navigation doesn't re-trigger the switch.
  const { hashtag: routeHashtag } = useParams<{ hashtag: string }>();
  const navigate = useNavigate();
  const handledRouteHashtagRef = useRef<string | null>(null);
  useEffect(() => {
    if (!routeHashtag) return;
    const norm = decodeURIComponent(routeHashtag).replace(/^#/, '').toLowerCase();
    // Same charset core accepts for a hashtag feed source — never trust a path segment.
    if (!norm || !/^[\p{L}\p{N}_]+$/u.test(norm)) return;
    if (handledRouteHashtagRef.current === norm) return;
    handledRouteHashtagRef.current = norm;
    confirmOpenHashtagFeed(norm);
    navigate('/', { replace: true });
  }, [routeHashtag, confirmOpenHashtagFeed, navigate]);

  // ─── Migrate legacy "friends" (individual pubkey tabs) to custom corkboards ──
  // Friends were stored as an array of pubkeys; each becomes a single-pubkey corkboard.
  useEffect(() => {
    try {
      const raw = localStorage.getItem('nostr-friends') ?? idbGetSync('nostr-friends');
      if (!raw) return;
      const legacyFriends: string[] = JSON.parse(raw);
      if (!Array.isArray(legacyFriends) || legacyFriends.length === 0) return;

      // Avoid re-migrating: check if these pubkeys already exist as single-pubkey feeds
      setCustomFeeds(prev => {
        const existingSinglePubkeys = new Set(
          prev.filter(f => f.pubkeys.length === 1).map(f => f.pubkeys[0])
        );
        const newFeeds = legacyFriends
          .filter(pk => !existingSinglePubkeys.has(pk))
          .map(pk => ({
            id: `migrated-${pk.slice(0, 8)}`,
            title: genUserName(pk),
            pubkeys: [pk],
            relays: [] as string[],
            rssUrls: [] as string[],
          }));
        if (newFeeds.length === 0) return prev;
        return [...prev, ...newFeeds];
      });

      // Clear legacy storage
      localStorage.removeItem('nostr-friends');
      idbSetSync('nostr-friends', '[]');

      // If activeTab was a raw pubkey (old friend tab), switch to the migrated feed
      const current = activeTab;
      if (legacyFriends.includes(current)) {
        setActiveTab(`feed:migrated-${current.slice(0, 8)}`);
      }
    } catch {
      // Migration is best-effort
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount

  // ─────────────────────────────────────────────────────────────────────────────
  // DERIVED FILTER SETTINGS - Single source of truth
  // ─────────────────────────────────────────────────────────────────────────────
  // Filter settings are derived synchronously from _tabFilters (built-in tabs) or
  // customFeeds (custom corkboards). This eliminates:
  // - Visual glitch on tab switch (settings update instantly with activeTab)
  // - Race conditions between load/save effects
  // - Multiple sources of truth for filter state
  // - Need for tabSettingsLoadedRef guard

  // Get current tab's filter settings synchronously
  const currentTabSettings = useMemo<TabFilterSettings>(() => {
    if (activeTab.startsWith('feed:')) {
      const feedId = activeTab.replace('feed:', '');
      const feed = customFeeds.find(f => f.id === feedId);
      // New custom feeds load unfiltered by default (empty settings)
      return feed?.filterSettings ?? {};
    }
    return _tabFilters[activeTab] ?? {};
  }, [activeTab, _tabFilters, customFeeds]);

  // Derive individual filter values (replaces 15+ useState hooks)
  const hideMinChars = currentTabSettings.hideMinChars ?? 0;
  const hideOnlyEmoji = currentTabSettings.hideOnlyEmoji ?? false;
  const allowPV = currentTabSettings.allowPV ?? false;
  const allowGM = currentTabSettings.allowGM ?? false;
  const allowGN = currentTabSettings.allowGN ?? false;
  const allowEyes = currentTabSettings.allowEyes ?? false;
  const allow100 = currentTabSettings.allow100 ?? false;
  const hideOnlyMedia = currentTabSettings.hideOnlyMedia ?? false;
  const hideOnlyLinks = currentTabSettings.hideOnlyLinks ?? false;
  const hideHtml = currentTabSettings.hideHtml ?? false;
  const hideMarkdown = currentTabSettings.hideMarkdown ?? false;
  const hideExactText = currentTabSettings.hideExactText ?? '';
  // The input stays bound to hideExactText so typing feels instant; the FEED
  // reads the debounced copy. Every keystroke otherwise re-ran the whole
  // pipeline — dedupe, classify, filter, sort, recount hashtags — across every
  // loaded note, which is what made typing in this box lag.
  const debouncedHideExactText = useDebouncedValue(hideExactText, 250);
  const showOwnNotes = currentTabSettings.showOwnNotes ?? false;
  const showPinned = currentTabSettings.showPinned ?? true;
  const showUnpinned = currentTabSettings.showUnpinned ?? true;

  // Kind/hashtag filters are Sets (for efficient lookup in filter logic).
  // The Set holds the kinds that are HIDDEN. Default for never-configured tabs
  // hides reactions (all other kinds shown); once the user touches kind filters,
  // an explicit array is persisted (see handleFilterByKind) and this default no
  // longer applies to that tab.
  const kindFilters = useMemo(() => new Set<KindFilter>((currentTabSettings.kindFilters ?? ['reactions']) as KindFilter[]), [currentTabSettings]);
  const filterMode: 'any' | 'strict' = currentTabSettings.filterMode ?? 'any';
  const hashtagFilters = useMemo(() => new Set<string>(currentTabSettings.hashtagFilters ?? []), [currentTabSettings]);

  // Content filter config object — drives both the ContentFilters UI and the
  // shared @core predicate that actually filters the feed. hideHtml has no
  // control in the panel but is a per-tab setting, so it belongs here too;
  // leaving it out meant the feed predicate and the UI disagreed about state.
  const contentFilterConfig = useMemo<ContentFilterConfig>(() => ({
    hideMinChars, hideOnlyEmoji, hideOnlyMedia, hideOnlyLinks,
    hideMarkdown, hideHtml, hideExactText, allowPV, allowGM, allowGN, allowEyes, allow100,
  }), [hideMinChars, hideOnlyEmoji, hideOnlyMedia, hideOnlyLinks, hideMarkdown, hideHtml, hideExactText, allowPV, allowGM, allowGN, allowEyes, allow100]);

  // Same config, but carrying the debounced text — this is what the feed filters
  // on. Built from the primitives rather than by spreading contentFilterConfig:
  // that object's identity changes on every keystroke, so spreading it would
  // change this one's identity too and the feed memo would re-run regardless of
  // the debounce.
  const feedContentFilterConfig = useMemo<ContentFilterConfig>(() => ({
    hideMinChars, hideOnlyEmoji, hideOnlyMedia, hideOnlyLinks,
    hideMarkdown, hideHtml, hideExactText: debouncedHideExactText,
    allowPV, allowGM, allowGN, allowEyes, allow100,
  }), [hideMinChars, hideOnlyEmoji, hideOnlyMedia, hideOnlyLinks, hideMarkdown, hideHtml, debouncedHideExactText, allowPV, allowGM, allowGN, allowEyes, allow100]);

  // Column count: per-tab from settings, separate for small/large screens
  const isSmallScreen = window.innerWidth < 768;
  const tabColumnCount = isSmallScreen
    ? (currentTabSettings.columnCountSmall ?? 1)
    : (currentTabSettings.columnCount ?? defaultColumnCount);
  const columnCountDerived = tabColumnCount;

  // Update function: writes to the correct source (tabFilters or customFeeds)
  const updateFilterSetting = useCallback(<K extends keyof TabFilterSettings>(
    key: K,
    value: TabFilterSettings[K]
  ) => {
    if (activeTab.startsWith('feed:')) {
      setCustomFeeds(prev => prev.map(f =>
        `feed:${f.id}` === activeTab
          ? { ...f, filterSettings: { ...f.filterSettings, [key]: value } }
          : f
      ));
    } else {
      setTabFilters(prev => ({
        ...prev,
        [activeTab]: { ...prev[activeTab], [key]: value }
      }));
    }
  }, [activeTab, setCustomFeeds, setTabFilters]);

  const handleContentFilterChange = useCallback((key: ContentFilterKey, value: number | boolean | string) => {
    updateFilterSetting(key as keyof TabFilterSettings, value as TabFilterSettings[keyof TabFilterSettings]);
  }, [updateFilterSetting]);

  // Individual setters for UI bindings
  const setHideMinChars = useCallback((v: number) => updateFilterSetting('hideMinChars', v), [updateFilterSetting]);
  const setHideOnlyEmoji = useCallback((v: boolean) => updateFilterSetting('hideOnlyEmoji', v), [updateFilterSetting]);
  const setHideOnlyMedia = useCallback((v: boolean) => updateFilterSetting('hideOnlyMedia', v), [updateFilterSetting]);
  const setHideOnlyLinks = useCallback((v: boolean) => updateFilterSetting('hideOnlyLinks', v), [updateFilterSetting]);
  const setHideHtml = useCallback((v: boolean) => updateFilterSetting('hideHtml', v), [updateFilterSetting]);
  const setHideMarkdown = useCallback((v: boolean) => updateFilterSetting('hideMarkdown', v), [updateFilterSetting]);
  const setHideExactText = useCallback((v: string) => updateFilterSetting('hideExactText', v), [updateFilterSetting]);
  const setShowOwnNotes = useCallback((v: boolean) => updateFilterSetting('showOwnNotes', v), [updateFilterSetting]);
  const setShowPinned = useCallback((v: boolean) => updateFilterSetting('showPinned', v), [updateFilterSetting]);
  const setShowUnpinned = useCallback((v: boolean) => updateFilterSetting('showUnpinned', v), [updateFilterSetting]);

  // Per-tab autofetch / media / consolidate / scroll-top (override globals when set per-corkboard)
  const autofetch = isSmallScreenNow
    ? (currentTabSettings.autofetchSmall ?? autofetchSmall)
    : (currentTabSettings.autofetch ?? autofetchLarge);
  const setAutofetch = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    const newVal = typeof v === 'function' ? v(autofetch) : v;
    const key: keyof TabFilterSettings = isSmallScreenNow ? 'autofetchSmall' : 'autofetch';
    updateFilterSetting(key, newVal);
  }, [autofetch, isSmallScreenNow, updateFilterSetting]);
  const loadAllMedia = isSmallScreenNow
    ? (currentTabSettings.loadAllMediaSmall ?? loadAllMediaSmall)
    : (currentTabSettings.loadAllMedia ?? loadAllMediaLarge);
  const setLoadAllMedia = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    const newVal = typeof v === 'function' ? v(loadAllMedia) : v;
    const key: keyof TabFilterSettings = isSmallScreenNow ? 'loadAllMediaSmall' : 'loadAllMedia';
    updateFilterSetting(key, newVal);
  }, [loadAllMedia, isSmallScreenNow, updateFilterSetting]);
  const autoConsolidate = currentTabSettings.autoConsolidate ?? _autoConsolidate;
  const setAutoConsolidate = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    const newVal = typeof v === 'function' ? v(autoConsolidate) : v;
    updateFilterSetting('autoConsolidate', newVal);
  }, [autoConsolidate, updateFilterSetting]);
  const autoScrollTop = currentTabSettings.autoScrollTop ?? _autoScrollTop;
  const setAutoScrollTop = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    const newVal = typeof v === 'function' ? v(autoScrollTop) : v;
    updateFilterSetting('autoScrollTop', newVal);
  }, [autoScrollTop, updateFilterSetting]);
  autofetchRef.current = autofetch;

  // Kind/hashtag filter setters (convert Set to array)
  const setKindFilters = useCallback((v: Set<KindFilter>) => {
    updateFilterSetting('kindFilters', Array.from(v));
  }, [updateFilterSetting]);
  const setFilterMode = useCallback((mode: 'any' | 'strict') => {
    updateFilterSetting('filterMode', mode);
  }, [updateFilterSetting]);
  const setHashtagFilters = useCallback((v: Set<string>) => {
    updateFilterSetting('hashtagFilters', Array.from(v));
  }, [updateFilterSetting]);

  // Column count setter - saves to the right key based on current screen size
  const [isColumnPending, startColumnTransition] = useTransition();
  const [optimisticColumnCount, setOptimisticColumnCount] = useState(columnCount);
  const handleColumnCountChange = useCallback((newCount: number) => {
    setOptimisticColumnCount(newCount);
    startColumnTransition(() => {
      setColumnCount(newCount);
      if (window.innerWidth < 768) {
        updateFilterSetting('columnCountSmall', newCount);
      } else {
        updateFilterSetting('columnCount', newCount);
      }
    });
  }, [updateFilterSetting]);

  // Load more follows in the follows list
  const handleLoadMoreFollows = useCallback(() => {
    setFollowsOffset(prev => prev + 100);
  }, []);

  // Feed builder state
  const [feedTitle, setFeedTitle] = useState('');
  const [feedPubkeys, setFeedPubkeys] = useState<Set<string>>(new Set());
  const [feedRelays, setFeedRelays] = useState<string>('');
  const [feedRssUrls, setFeedRssUrls] = useState<Set<string>>(new Set());
  const [feedHashtags, setFeedHashtags] = useState<Set<string>>(new Set());

  /** Parse raw input into a feed source type + value, or null if unrecognized. */
  // Shared with mobile via @core/feedSource — nip19 is injected so core stays
  // dependency-free. Keeps the corkboard builder's source classification identical
  // across platforms.
  const parseFeedSource = useCallback((raw: string) => parseFeedSourceCore(raw, (input) => {
    try {
      const decoded = nip19.decode(input);
      if (decoded.type === 'npub') return decoded.data as string;
      if (decoded.type === 'nprofile') return (decoded.data as { pubkey: string }).pubkey;
    } catch { /* not an npub/nprofile */ }
    return null;
  }), []);

  /** Add raw input as a feed source (updates state). Supports comma-separated values. Returns true if at least one was recognized. */
  const addFeedSource = useCallback((raw: string): boolean => {
    // Split on commas to support pasting multiple npubs/sources at once
    const items = raw.split(',').map(s => s.trim()).filter(Boolean);
    let anyAdded = false;

    for (const item of items) {
      const parsed = parseFeedSource(item);
      if (!parsed) continue;
      anyAdded = true;

      if (parsed.type === 'relay') {
        const current = feedRelays ? feedRelays.split(',').map(r => r.trim()).filter(Boolean) : [];
        if (!current.includes(parsed.value)) {
          setFeedRelays([...current, parsed.value].join(', '));
        }
      } else if (parsed.type === 'rss') {
        setFeedRssUrls(prev => new Set([...prev, parsed.value]));
        // Notify when we upgraded http:// → https:// (feeds load via an HTTPS-only proxy)
        if (parsed.httpsUpgraded) {
          toast({ title: 'Changed to HTTPS', description: "Feeds load over a secure (HTTPS) proxy, so we switched http:// to https://. If this feed doesn't load, it may only be served over plain HTTP." });
        }
        // Pre-check RSS validity in background (via proxy to avoid CORS)
        import('@core/feedConstants').then(({ RSS_PROXY }) => {
          fetch(`${RSS_PROXY}?url=${encodeURIComponent(parsed.value)}&max=1`, { signal: AbortSignal.timeout(8000) })
            .then(r => r.json())
            .then(data => {
              if (data.error) toast({ title: 'RSS warning', description: data.error, variant: 'destructive' });
            })
            .catch(() => {
              toast({ title: 'RSS warning', description: 'Could not reach feed — it may be down', variant: 'destructive' });
            });
        });
      } else if (parsed.type === 'hashtag') {
        setFeedHashtags(prev => new Set([...prev, parsed.value]));
      } else {
        setFeedPubkeys(prev => new Set([...prev, parsed.value]));
      }
    }

    if (anyAdded) setNewFriendInput('');
    return anyAdded;
  }, [feedRelays, parseFeedSource, toast]);

  // Create or update a custom feed (called from TabBar dialog)
  const handleCreateOrUpdateFeed = useCallback(() => {
    if (!feedTitle.trim()) {
      toast({ title: 'Please enter a name for your corkboard', variant: 'destructive' });
      return;
    }
    const finalPubkeys = new Set(feedPubkeys);
    let finalRelays = feedRelays;
    const finalRssUrls = new Set(feedRssUrls);
    const finalHashtags = new Set(feedHashtags);
    // Process any pending input (supports comma-separated values)
    const pendingItems = newFriendInput.split(',').map(s => s.trim()).filter(Boolean);
    for (const item of pendingItems) {
      const pending = parseFeedSource(item);
      if (!pending) continue;
      if (pending.type === 'pubkey') finalPubkeys.add(pending.value);
      else if (pending.type === 'relay') {
        const current = finalRelays ? finalRelays.split(',').map(r => r.trim()).filter(Boolean) : [];
        if (!current.includes(pending.value)) finalRelays = [...current, pending.value].join(', ');
      } else if (pending.type === 'rss') finalRssUrls.add(pending.value);
      else if (pending.type === 'hashtag') finalHashtags.add(pending.value);
    }
    if (finalPubkeys.size === 0 && !finalRelays.trim() && finalRssUrls.size === 0 && finalHashtags.size === 0) {
      toast({ title: 'Please add at least one source', variant: 'destructive' });
      return;
    }
    const relayList = finalRelays ? finalRelays.split(',').map(r => r.trim()).filter(r => r.startsWith('wss://') || r.startsWith('ws://')) : [];
    const existingFeed = customFeeds.find(f => f.id === editingFeedId);
    const updatedFeed: CustomFeed = {
      id: editingFeedId || Date.now().toString(),
      title: feedTitle.trim(),
      pubkeys: Array.from(finalPubkeys),
      relays: relayList,
      rssUrls: Array.from(finalRssUrls),
      hashtags: Array.from(finalHashtags),
      filterSettings: existingFeed?.filterSettings,
    };
    if (editingFeedId) {
      setCustomFeeds(customFeeds.map(f => f.id === editingFeedId ? updatedFeed : f));
      toast({ title: 'Corkboard updated!', description: `"${updatedFeed.title}" has been saved` });
    } else {
      setCustomFeeds([...customFeeds, updatedFeed]);
      toast({ title: 'Corkboard created!', description: `"${updatedFeed.title}" has been added` });
    }
    setFeedTitle('');
    setFeedPubkeys(new Set());
    setFeedRelays('');
    setFeedRssUrls(new Set());
    setFeedHashtags(new Set());
    setEditingFeedId(null);
    setShowAddFriendDialog(false);
    setBackupIndicator('unsaved');
  }, [feedTitle, feedPubkeys, feedRelays, feedRssUrls, feedHashtags, newFriendInput, editingFeedId, customFeeds, parseFeedSource, setCustomFeeds, toast]);

  // Pinned notes
  const { pinnedIds, pinnedNotes: pinnedNoteEvents, pinnedNotesStatus, isLoading: isLoadingPinnedNotes, togglePin } = usePinnedNotes();

  // Toggle pinning a note (publishes NIP-51 kind 10001)
  const handlePinNote = useCallback((noteId: string) => {
    const wasPinned = pinnedIds.includes(noteId);
    togglePin(noteId);
    toast({ title: wasPinned ? 'Unpinned' : 'Pinned' });
  }, [togglePin, pinnedIds, toast]);

  // "Pin to board" dialog state
  const [pinToBoardNote, setPinToBoardNote] = useState<NostrEvent | null>(null);

  // Delete user's own note (NIP-09 kind 5 deletion request)
  const handleDeleteNote = useCallback((note: NostrEvent) => {
    if (note.pubkey !== user?.pubkey) return;
    createEvent(
      { kind: 5, content: 'Deleted by author', tags: [['e', note.id]] },
      {
        onSuccess: () => {
          toast({ title: 'Deleted', description: 'Deletion request published to relays' });
          // Dismiss locally so it disappears from the feed immediately
          dismiss(note.id);
        },
        onError: (err) => {
          toast({ title: 'Delete failed', description: String(err), variant: 'destructive' });
        },
      },
    );
  }, [user?.pubkey, createEvent, dismiss, toast]);

  // Called from FeedGrid "Pin to board" button — opens the confirmation dialog
  const handlePinToBoard = useCallback((note: NostrEvent) => {
    setPinToBoardNote(note);
  }, []);

  // Execute pin-to-board: add to kind 10001 pin list (no repost).
  // The original note is fetched by usePinnedNotes from the event ID.
  const executePinToBoard = useCallback((note: NostrEvent) => {
    const wasAlreadyPinned = pinnedIds.includes(note.id);
    if (wasAlreadyPinned) {
      togglePin(note.id); // unpin first for re-pin
    }
    togglePin(note.id);
    toast({ title: wasAlreadyPinned ? 'Re-pinned to your corkboard' : 'Pinned to your corkboard' });
    setPinToBoardNote(null);
  }, [pinnedIds, togglePin, toast]);

  // Execute pin-to-board with comment: open compose as quote, pin after publish
  // For re-pin: unpin first, then compose + pin
  const executePinToBoardWithComment = useCallback((note: NostrEvent) => {
    const wasAlreadyPinned = pinnedIds.includes(note.id);
    // Unpin first if re-pinning
    if (wasAlreadyPinned) {
      togglePin(note.id);
    }

    setPinToBoardNote(null);
    setComposeReplyTo(null);
    setComposeQuotedEvent(note);
    setComposeRepostEvent(null);
    threadRefreshRef.current = null;
    pinAfterPublishRef.current = () => {
      togglePin(note.id);
    };
    setIsComposeOpen(true);
  }, [pinnedIds, togglePin]);



  // filtersOpen state now managed internally by ContentFilters component

  // Sync columnCount with derived value (responsive: mobile → 1 column)
  useEffect(() => {
    setColumnCount(columnCountDerived);
    setOptimisticColumnCount(columnCountDerived);
  }, [columnCountDerived]);

  // Fetch user's follows (kind 3 contacts) — critical query, must not fail silently
  const { data: contacts, isLoading: isLoadingContacts } = useQuery({
    queryKey: ['contacts', user?.pubkey],
    queryFn: async () => {
      if (!user?.pubkey) return [];

      const signal = AbortSignal.timeout(10000);
      const events = await nostr.query([
        {
          kinds: [3],
          authors: [user.pubkey],
          limit: 5 // Fetch several to ensure we get the latest replaceable event
        }
      ], { signal });

      if (events.length === 0) {
        debugLog('[contacts] No kind-3 events returned — zero contacts or relay miss');
        return [];
      }

      // Kind 3 is replaceable — use the most recent event
      const contactEvent = events.sort((a, b) => b.created_at - a.created_at)[0];
      const contactTags = contactEvent.tags.filter(tag => tag[0] === 'p');
      const pubkeys = contactTags.map(tag => tag[1]);
      debugLog(`[contacts] Loaded ${pubkeys.length} contacts from kind-3 (created_at=${contactEvent.created_at})`);
      return pubkeys;
    },
    enabled: !!user?.pubkey && canLoadNotes,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
  });

  // Fetch profile data for follows
  const { data: followsData, isLoading: isLoadingFollows } = useQuery({
    queryKey: ['follows-data', contacts, followsOffset],
    queryFn: async () => {
      if (!contacts || contacts.length === 0) return [];

      const authorBatch = contacts.slice(followsOffset, followsOffset + FOLLOWS_BATCH_SIZE);
      debugLog('[follows-data] Fetching profiles for', authorBatch.length, 'authors using outbox model');

      // Check cache first
      const cachedProfiles = await getCachedProfiles(authorBatch);
      const needRefresh = await getProfilesNeedingRefresh(authorBatch);
      
      debugLog('[follows-data] Cache hit:', cachedProfiles.size, '/', authorBatch.length);
      debugLog('[follows-data] Need refresh:', needRefresh.length, 'profiles');

      // Fetch profiles that need refresh — two passes with increasing timeout
      const fetchedProfiles = new Map<string, { pubkey: string; name: string; picture?: string }>();
      if (needRefresh.length > 0) {
        const fetchBatch = async (authors: string[], timeoutMs: number) => {
          try {
            const signal = AbortSignal.timeout(timeoutMs);
            const events = await nostr.query([{
              kinds: [0],
              authors,
              limit: authors.length,
            }], { signal });

            await setCachedProfiles(events);
            await Promise.all(events.map(event => markProfileRefreshed(event.pubkey)));

            for (const event of events) {
              try {
                const metadata = JSON.parse(event.content);
                fetchedProfiles.set(event.pubkey, {
                  pubkey: event.pubkey,
                  name: metadata.name || metadata.display_name || genUserName(event.pubkey),
                  picture: metadata.picture,
                });
              } catch {
                fetchedProfiles.set(event.pubkey, {
                  pubkey: event.pubkey,
                  name: genUserName(event.pubkey),
                  picture: undefined,
                });
              }
            }
            return events.map(e => e.pubkey);
          } catch {
            return [];
          }
        };

        // First pass: 6s timeout for all
        const resolved = await fetchBatch(needRefresh, 6000);
        const resolvedSet = new Set(resolved);
        const stillMissing = needRefresh.filter(pk => !resolvedSet.has(pk));

        // Retry pass: 8s for those that failed (relays may have been slow)
        if (stillMissing.length > 0) {
          debugLog('[follows-data] Retrying', stillMissing.length, 'unresolved profiles');
          await fetchBatch(stillMissing, 8000);
        }
      }

      // Combine cached and fetched profiles
      const allProfiles = new Map([...cachedProfiles, ...fetchedProfiles]);
      
      // Return in the same order as authorBatch
      return authorBatch.map(pubkey => {
        const profile = allProfiles.get(pubkey);
        if (profile) {
          return profile;
        }
        // Fallback if not found
        return {
          pubkey,
          name: genUserName(pubkey),
          picture: undefined
        };
      });
    },
    enabled: contacts && contacts.length > 0
  });

  // Accumulate follows data — replace placeholders when real profiles arrive
  useEffect(() => {
    if (followsData && followsData.length > 0) {
      setAllFollowsData(prev => {
        const existingMap = new Map(prev.map(f => [f.pubkey, f]));
        let changed = false;
        for (const f of followsData) {
          const existing = existingMap.get(f.pubkey);
          if (!existing) {
            existingMap.set(f.pubkey, f);
            changed = true;
          } else if (!existing.picture && f.picture) {
            // Replace placeholder (no avatar) with resolved profile
            existingMap.set(f.pubkey, f);
            changed = true;
          }
        }
        if (!changed) return prev;
        return [...existingMap.values()];
      });
      setIsLoadingMoreFollows(false);
    }
  }, [followsData]);

  // Whether another page of follows exists — DERIVED from the last batch, not
  // state. It used to be `useState(true)` whose setter (`_setHasMoreFollows`)
  // was never called anywhere, so "Load more" was offered forever, including on
  // accounts whose entire follow list had already loaded.
  const hasMoreFollows = (contacts?.length ?? 0) > followsOffset + FOLLOWS_BATCH_SIZE;

  // Update availableFollows when dialog is opened
  useEffect(() => {
    if (showAddFriendDialog) {
      setAvailableFollows(allFollowsData);
    }
  }, [showAddFriendDialog, allFollowsData]);

  // Tab type flags
  const isRelayTab = activeTab.startsWith('wss://') || activeTab.startsWith('ws://');
  const isCustomFeedTab = activeTab.startsWith('feed:');
  const isDiscoverTab = activeTab === 'discover';
  const isAllFollowsTab = activeTab === 'all-follows';
  const isRssTab = activeTab.startsWith('rss:');
  const activeRssFeed = isRssTab ? activeTab.slice(4) : null; // Remove 'rss:' prefix
  const isSavedTab = activeTab === 'saved';
  const activeCustomFeed = customFeeds.find(f => `feed:${f.id}` === activeTab) ?? null;
  const isNotificationsTab = activeTab === 'notifications';
  const isFriendTab = !isRelayTab && !isCustomFeedTab && !isDiscoverTab && !isAllFollowsTab && !isRssTab && !isSavedTab && !isNotificationsTab && activeTab !== 'me';

  // Notification load-more state — surfaced from NotificationsCorkboard for StatusBar
  const notifLoadMoreRef = useRef<((count: number) => void) | null>(null);
  const notifLoadNewerRef = useRef<(() => void) | null>(null);
  const [notifHasMore, setNotifHasMore] = useState(false);
  const [notifNewestTimestamp, setNotifNewestTimestamp] = useState<number | null>(null);
  const [notifStats, setNotifStats] = useState<{ total: number; visible: number; dismissed: number; filtered: number }>({ total: 0, visible: 0, dismissed: 0, filtered: 0 });
  const handleNotifLoadMoreReady = useCallback((loadMore: (count: number) => void, hasMore: boolean, loadNewer: () => void, newestTs: number | null) => {
    notifLoadMoreRef.current = loadMore;
    notifLoadNewerRef.current = loadNewer;
    setNotifHasMore(hasMore);
    setNotifNewestTimestamp(newestTs);
  }, []);

  // Onboard procedure: active when contacts have loaded and user follows fewer than 10 people.
  // Skip after a backup restore (backupStatus 'restored') so returning users aren't
  // dropped back into onboarding while their contacts are still loading.
  const [onboardingSkipped, setOnboardingSkipped] = useLocalStorage<boolean>(STORAGE_KEYS.ONBOARDING_SKIPPED, false);
  const [onboardFollowTarget, setOnboardFollowTarget] = useLocalStorage<number>(STORAGE_KEYS.ONBOARDING_FOLLOW_TARGET, 10);
  const wasRestoredRef = useRef(false);
  if (backupStatus === 'restored' || backupStatus === 'restoring') wasRestoredRef.current = true;

  // Persisted per-pubkey "has onboarded" flag — survives logout/login so a user
  // who skipped/completed isn't re-prompted every login. Default true (don't
  // onboard) until we've actually read storage, which also avoids the cold-load
  // race where the guide flashed before the skip flag loaded.
  const [onboardFlagLoaded, setOnboardFlagLoaded] = useState(false);
  const [hasOnboardedFlag, setHasOnboardedFlag] = useState(true);
  useEffect(() => {
    const pk = user?.pubkey;
    if (!pk) { setHasOnboardedFlag(true); setOnboardFlagLoaded(false); return; }
    let cancelled = false;
    setOnboardFlagLoaded(false);
    onboardIdbReady.then(() => {
      if (cancelled) return;
      setHasOnboardedFlag(getOnboarded(pk));
      setOnboardFlagLoaded(true);
    });
    return () => { cancelled = true; };
  }, [user?.pubkey]);

  const markOnboarded = useCallback(() => {
    const pk = user?.pubkey;
    if (pk) { setOnboarded(pk); setHasOnboardedFlag(true); }
  }, [user?.pubkey]);

  const isOnboarding = onboardFlagLoaded && !hasOnboardedFlag
    && contacts !== undefined && contacts.length < onboardFollowTarget
    && !onboardingSkipped && !wasRestoredRef.current;

  // Open the edit-profile dialog the first time onboarding completes (contacts reach 10).
  // Skip if onboarding was dismissed via a backup restore (user already set up their profile).
  const onboardingWasActiveRef = useRef(false);
  useEffect(() => {
    if (isOnboarding) {
      onboardingWasActiveRef.current = true;
    } else if (onboardingWasActiveRef.current && !wasRestoredRef.current && !onboardingSkipped) {
      onboardingWasActiveRef.current = false;
      // Persist completion so later unfollows (contacts dropping below target)
      // don't drop the user back into onboarding.
      markOnboarded();
      setEditProfileOpen(true);
    }
  }, [isOnboarding, onboardingSkipped, markOnboarded]);

  // Auto-switch to discover tab on first contacts load when following fewer than 10 people
  const contactsFirstLoadRef = useRef<string | null>(null);
  useEffect(() => {
    if (contacts === undefined || !user?.pubkey || !onboardFlagLoaded) return;
    // Reset when user changes (account switch)
    if (contactsFirstLoadRef.current === user.pubkey) return;
    contactsFirstLoadRef.current = user.pubkey;
    if (!hasOnboardedFlag && contacts.length < onboardFollowTarget && !onboardingSkipped && (activeTab === 'me' || activeTab === 'discover')) {
      setActiveTab('discover');
    }
  // setActiveTab is stable but not listed to avoid stale-closure lint noise
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts, user?.pubkey, onboardFlagLoaded]);

  // Stable ref for the pagination setBatchProgress, so feed hooks can call it
  // before useFeedPagination has been initialised (hooks must always run in order).
  const batchProgressCallbackRef = useRef<((p: { loaded: number; total: number } | null) => void) | null>(null);
  const paginationSetBatchProgress = useCallback((p: { loaded: number; total: number } | null) => {
    batchProgressCallbackRef.current?.(p);

  }, [batchProgressCallbackRef]);

  // Discover feature - find content from non-followed users that friends engaged with
  // Use limit 200 during onboarding to make room for merged seeded notes
  const {
    discoveredNotes,
    isLoading: isLoadingDiscover,
    refresh: refreshDiscover,
    loadMore: loadMoreDiscover,
    hasMoreDiscover,
    totalDiscoverCount,
  } = useDiscover(contacts, canLoadNotes && isDiscoverTab);

  // Onboard discover: seeded notes from curator npubs' follows (only during onboard procedure)
  const {
    notes: onboardSeedNotes,
    isLoading: isLoadingOnboardSeed,
  } = useOnboardDiscover(contacts ?? [], isOnboarding && canLoadNotes && isDiscoverTab, user?.pubkey);

  // Follow activity during onboarding: reactions, reposts, replies from current follows.
  // fetchNow is wired to the "Find more for me" button — no automatic refresh.
  const {
    notes: onboardFollowActivity,
    isLoading: isLoadingMoreOnboard,
    fetchNow: fetchMoreOnboardActivity,
  } = useOnboardFollowActivity(contacts, isOnboarding && canLoadNotes && isDiscoverTab && (contacts?.length ?? 0) > 0);

  // Merge discover + seeded notes + follow activity when onboarding
  const mergedDiscoverNotes = useMemo(() => {
    if (!isOnboarding) return discoveredNotes;

    // Combine discover + seed notes — preserve arrival order (no sort)
    // so new notes always appear at the bottom of the feed.
    const discoverPool = [...onboardSeedNotes, ...discoveredNotes];
    const seen = new Set<string>();
    const dedupedDiscover = discoverPool.filter(n => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    });

    // Dedup follow activity against discover notes
    const dedupedActivity = onboardFollowActivity.filter(n => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    });

    if (dedupedActivity.length === 0) return dedupedDiscover;

    // Interleave: insert 1 activity note every 4 discover notes (≤20%)
    const result: NostrEvent[] = [];
    let actIdx = 0;
    for (let i = 0; i < dedupedDiscover.length; i++) {
      result.push(dedupedDiscover[i]);
      if ((i + 1) % 4 === 0 && actIdx < dedupedActivity.length) {
        result.push(dedupedActivity[actIdx++]);
      }
    }
    // Append any remaining activity notes at the end
    while (actIdx < dedupedActivity.length) {
      result.push(dedupedActivity[actIdx++]);
    }

    return result;
  }, [isOnboarding, discoveredNotes, onboardSeedNotes, onboardFollowActivity]);

  // Stable append-only discover notes: new notes always go to the bottom, existing
  // notes never change position. Prevents columns from jumping when engagement data
  // updates or new notes arrive mid-session.
  // Also enforces: one card per npub (first note wins), no self-reposts.
  const [stableDiscoverNotes, setStableDiscoverNotes] = useState<NostrEvent[]>([]);
  const stableDiscoverSeenRef = useRef(new Set<string>());
  const stableDiscoverPubkeysRef = useRef(new Set<string>());
  // Reset stable list when the user changes account
  const stableDiscoverUserRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (stableDiscoverUserRef.current !== user?.pubkey) {
      stableDiscoverUserRef.current = user?.pubkey;
      setStableDiscoverNotes([]);
      stableDiscoverSeenRef.current = new Set();
      stableDiscoverPubkeysRef.current = new Set();
    }
  }, [user?.pubkey]);
  // Append genuinely new notes to the stable list (don't re-order existing ones)
  useEffect(() => {
    if (!isDiscoverTab) return;
    const source = isOnboarding ? mergedDiscoverNotes : discoveredNotes;
    const fresh: NostrEvent[] = [];
    for (const n of source) {
      if (stableDiscoverSeenRef.current.has(n.id)) continue;
      // Skip self-reposts: kind 6/16 where the reposter is the original author
      if ((n.kind === 6 || n.kind === 16) && n.tags.some(t => t[0] === 'p' && t[1] === n.pubkey)) continue;
      // Determine the "featured" pubkey — for reposts/reactions from followed users,
      // the featured person is the original author (the one the viewer might follow).
      let featuredPubkey = n.pubkey;
      if ((n.kind === 6 || n.kind === 16) && contacts?.includes(n.pubkey)) {
        featuredPubkey = n.tags.find(t => t[0] === 'p')?.[1] ?? n.pubkey;
      } else if ((n.kind === 7 || n.kind === 9735) && contacts?.includes(n.pubkey)) {
        featuredPubkey = n.tags.find(t => t[0] === 'p')?.[1] ?? n.pubkey;
      }
      // Skip npubs the user already follows — discover is for finding new people
      if (contacts?.includes(featuredPubkey)) continue;
      // One card per featured npub — skip if we already have a note featuring this person
      if (stableDiscoverPubkeysRef.current.has(featuredPubkey)) continue;
      stableDiscoverSeenRef.current.add(n.id);
      stableDiscoverPubkeysRef.current.add(featuredPubkey);
      fresh.push(n);
    }
    if (fresh.length === 0) return;
    // Cap the live set. Discover appends forever as relays stream new authors in,
    // and every retained note is both a NostrEvent and a mounted NoteCard (with
    // avatars and media) in the webview DOM — on a long session that grows without
    // bound. Keep the newest MAX_RETAINED_NOTES and let the oldest cards fall out;
    // the seen/pubkey refs below still suppress re-adding them, so dropped cards
    // stay dropped rather than cycling back in.
    setStableDiscoverNotes(prev => {
      const next = [...prev, ...fresh];
      return next.length > MAX_RETAINED_NOTES ? next.slice(-MAX_RETAINED_NOTES) : next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDiscoverTab, isOnboarding ? mergedDiscoverNotes : discoveredNotes]);

  // ─────────────────────────────────────────────────────────────────────────────
  // CENTRALIZED CACHE - Notes from all follows + self
  // ─────────────────────────────────────────────────────────────────────────────
  // Fetched once on load. Tabs filter from this cache locally.
  const {
    data: followNotesCache,
    isLoading: isLoadingFollowCache,
    getFilteredByPubkeys,
  } = useFollowNotesCache({
    contacts: contacts ?? [],
    selfPubkey: user?.pubkey,
    enabled: canLoadNotes && contacts !== undefined && contacts.length > 0,
    limit: feedLimit,
    multiplier: feedLimitMultiplier, // 1x/2x/3x for initial time window
    includeSelf: true, // Always include self in follow cache for other tabs to use
    onProgress: (loaded, total) => paginationSetBatchProgress({ loaded, total }),
  });

  // Clear batch progress when cache finishes loading
  useEffect(() => {
    if (!isLoadingFollowCache) paginationSetBatchProgress(null);
  }, [isLoadingFollowCache, paginationSetBatchProgress]);

  // Derive all-follows notes from cache
  const allFollowsNotes = followNotesCache;

  const isLoadingAllFollows = isLoadingFollowCache || isLoadingContacts;

  // Log note/contact counts when feed data settles
  useEffect(() => {
    if (isLoadingAllFollows) return;
    debugLog(`[feed] contacts=${contacts?.length ?? 0} followCache=${followNotesCache?.length ?? 0} pinnedIds=${pinnedIds.length} pinnedNotes=${pinnedNoteEvents?.length ?? 0} pinnedStatus=${pinnedNotesStatus}`);
  }, [isLoadingAllFollows, contacts, followNotesCache, pinnedIds, pinnedNoteEvents, pinnedNotesStatus]);
  
  // Reset extra notes when user changes (extraUserNotes state is defined earlier in the file)
  useEffect(() => {
    setExtraUserNotes([]);
    otherAuthorsSeenRef.current = {};
  }, [user?.pubkey]);

  // Called by loadMoreByCount when it fetches notes for the 'me' tab
  const handleMeTabNotesLoaded = useCallback((notes: NostrEvent[]) => {
    setExtraUserNotes(notes);
  }, []);

  // Called by fetchAndMergeUserNotes (pagination hook) whenever it pulls the
  // user's own notes for "include my notes". Merging into extraUserNotes is
  // what actually makes them render — the ['user-notes'] query cache the hook
  // also writes is only a pagination anchor; nothing displays from it.
  const handleUserNotesFetched = useCallback((notes: NostrEvent[]) => {
    setExtraUserNotes(prev => {
      const seen = new Set(prev.map(n => n.id));
      const fresh = notes.filter(n => !seen.has(n.id));
      // Intentionally NOT capped to MAX_RETAINED_NOTES: this is fed by
      // fetchAndMergeUserNotes during pagination, so the notes appended here are
      // ones the user explicitly paged for. Capping would slice them straight
      // back off. Same reasoning as useFeedLoadMore in mobile's useFeed.
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
  }, []);

  // Derive userNotes for "me" tab: own notes only (no pinned — those are added separately)
  const pinnedIdSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  // Only exclude a note from userNotes if it's both in pinnedIds AND already
  // fetched in pinnedNoteEvents. This prevents the note from disappearing
  // between the optimistic pin toggle and the relay event fetch.
  const pinnedAndFetchedSet = useMemo(() => {
    const fetchedIds = new Set((pinnedNoteEvents ?? []).map(e => e.id));
    return new Set(pinnedIds.filter(id => fetchedIds.has(id)));
  }, [pinnedIds, pinnedNoteEvents]);
  const userNotes = useMemo(() => {
    if (!user?.pubkey) return undefined;

    // Self notes from follow cache
    const selfNotesFromCache = followNotesCache?.filter(e => e.pubkey === user.pubkey) ?? [];

    // Combine sources, dedupe, exclude pinned notes that have been fetched (they're added separately)
    const seen = new Set<string>();
    const notes: NostrEvent[] = [];
    for (const note of [...selfNotesFromCache, ...extraUserNotes]) {
      if (!seen.has(note.id) && !pinnedAndFetchedSet.has(note.id) && note.pubkey === user.pubkey) {
        seen.add(note.id);
        notes.push(note);
      }
    }

    return notes.sort((a, b) => b.created_at - a.created_at);
  }, [user?.pubkey, followNotesCache, extraUserNotes, pinnedAndFetchedSet]);

  // Keep the ['user-notes'] React Query cache in sync with userNotes so loadMoreByCount
  // can use the oldest note as a pagination anchor.
  useEffect(() => {
    if (!user?.pubkey || !userNotes || userNotes.length === 0) return;
    queryClient.setQueryData(['user-notes', user.pubkey], userNotes);
  }, [user?.pubkey, userNotes, queryClient]);
  
  // When showOwnNotes is enabled, we also need followNotesCache to load.
  // Only block rendering (show skeleton) on initial load when we have no notes yet —
  // on subsequent refreshes, let existing notes stay visible while new data loads in bg.
  const hasExistingMeNotes = (pinnedNoteEvents && pinnedNoteEvents.length > 0) || (userNotes && userNotes.length > 0);
  const isLoadingUserNotes = !hasExistingMeNotes && (isLoadingPinnedNotes || isLoadingFollowCache);
  
  // Derive friend notes from cache (filter by pubkey)
  const friendNotes = useMemo(() => {
    if (!isFriendTab || !activeTab) return undefined;
    return getFilteredByPubkeys([activeTab]);
  }, [isFriendTab, activeTab, getFilteredByPubkeys]);
  const isLoadingFriendNotes = isLoadingFollowCache && isFriendTab;
  const userNoteKindStats = useMemo(() => {
    const allMeNotes = pinnedNoteEvents?.length
      ? [...(userNotes || []), ...pinnedNoteEvents]
      : userNotes;
    return computeNoteKindStats(allMeNotes);
  }, [userNotes, pinnedNoteEvents]);
  const friendNoteKindStats = useMemo(() => computeNoteKindStats(friendNotes), [friendNotes]);

  // Custom feed notes from separate cache to prevent interference with other tabs
  const {
    data: customFeedNotesData,
    isLoading: isLoadingCustomFeedNotes,
    loadOlder: loadCustomFeedOlder,
    loadNewer: _loadCustomFeedNewer,
    hasMore: customFeedHasMore,
  } = useCustomFeedNotesCache({
    feedId: activeCustomFeed?.id ?? '',
    pubkeys: activeCustomFeed?.pubkeys ?? [],
    enabled: canLoadNotes && isCustomFeedTab && activeCustomFeed !== null && (activeCustomFeed?.pubkeys?.length ?? 0) > 0,
    limit: feedLimit,
    multiplier: feedLimitMultiplier,
    ensureRelays: fetchRelaysForMultiple, // outbox pass: discover corkboard authors' relays first
    onProgress: (loaded, total) => paginationSetBatchProgress({ loaded, total }),
  });
  const isLookingFurtherCustomFeed = false;

  // Extra hashtag notes loaded by count-based pagination (+25, +100)
  const [extraHashtagNotes, setExtraHashtagNotes] = useState<NostrEvent[]>([]);
  useEffect(() => { setExtraHashtagNotes([]); }, [activeCustomFeed?.id]);

  // Hashtag notes for custom feed (fetched separately from author notes)
  const activeHashtags = activeCustomFeed?.hashtags ?? [];
  const { data: hashtagNotes, isLoading: isLoadingHashtagNotes } = useQuery({
    queryKey: ['hashtag-feed', activeCustomFeed?.id, activeHashtags.join(','), feedLimitMultiplier],
    queryFn: async () => {
      const { fetchByHashtags } = await import('@/lib/feedUtils');
      const now = Math.floor(Date.now() / 1000);
      // Wide window (7 days × multiplier), limit-capped: fetch the most recent
      // hashtag notes regardless of the (narrow) author window, so a hashtag's
      // notes actually appear on first load instead of only after paginating.
      const since = now - 3600 * 24 * 7 * feedLimitMultiplier;
      return fetchByHashtags({ nostr, hashtags: activeHashtags, limit: feedLimit, since });
    },
    enabled: canLoadNotes && isCustomFeedTab && activeHashtags.length > 0,
    staleTime: 60_000,
  });

  // RSS single-feed tab
  const { data: rssNotes, isLoading: isLoadingRss } = useRssFeed({
    feedUrl: activeRssFeed,
    enabled: canLoadNotes && isRssTab,
  });

  // Relay-browse tab (raw WebSocket) - still live query
  const { data: relayNotes, isLoading: isLoadingRelayNotes } = useRelayFeed({
    relayUrl: activeTab,
    enabled: canLoadNotes && isRelayTab && browseRelays.includes(activeTab),
    limit: feedLimit,
  });

  // RSS loading state for custom feeds
  const [isCustomRssLoading, setIsCustomRssLoading] = useState(false);

  // RSS for custom corkboard (if feed has RSS URLs) — fetches ALL URLs
  const hasRssInCustomFeed = isCustomFeedTab && (activeCustomFeed?.rssUrls?.length ?? 0) > 0;
  const activeRssUrls = hasRssInCustomFeed ? (activeCustomFeed?.rssUrls ?? []) : [];
  const { data: customFeedRssNotes, refetch: refetchCustomRss } = useQuery<NostrEvent[]>({
    queryKey: ['custom-feed-rss', activeCustomFeed?.id, activeRssUrls.join(',')],
    queryFn: async () => {
      const { fetchRssFeed, rssItemsToEvents } = await import('@/lib/feedUtils');
      const allNotes: NostrEvent[] = [];
      const seen = new Set<string>();
      await Promise.allSettled(activeRssUrls.map(async (url) => {
        const feed = await fetchRssFeed(url, 50);
        if (!feed) return;
        const notes = rssItemsToEvents(feed.items, feed.title, feed.icon, url);
        for (const n of notes) {
          if (!seen.has(n.id)) { seen.add(n.id); allNotes.push(n); }
        }
      }));
      return allNotes.sort((a, b) => b.created_at - a.created_at);
    },
    enabled: false, // Manual trigger only
    staleTime: Infinity,
  });

  const isLoadingCustomFeed = (isLoadingCustomFeedNotes && isCustomFeedTab) || isCustomRssLoading || (isLoadingHashtagNotes && isCustomFeedTab);

  // Derive corkboard notes from custom feed cache + RSS + hashtags
  const corkboardNotes = useMemo(() => {
    if (!isCustomFeedTab || !activeCustomFeed) return undefined;

    // The corkboard's own fetch (covers members you don't follow) + hashtag + RSS.
    const nostrNotes = customFeedNotesData ?? [];
    const htNotes = [...(hashtagNotes ?? []), ...extraHashtagNotes];
    const rss = customFeedRssNotes ?? [];

    // Reconcile with the all-follows cache: pull every note it holds for this
    // corkboard's members — and the user's own notes when "include my notes" is
    // on — so anything visible on 'all follows' also appears here, with the same
    // wider coverage. Dismiss is shared by note id, so the two stay consistent.
    const feedPubkeys = new Set(activeCustomFeed.pubkeys);
    if (showOwnNotes && user?.pubkey) feedPubkeys.add(user.pubkey);
    const fromFollowCache = (followNotesCache ?? []).filter(n => feedPubkeys.has(n.pubkey));

    // Merge corkboard fetch + follow-cache subset + hashtag notes, dedup by id.
    const allNostr: NostrEvent[] = [];
    const seenIds = new Set<string>();
    for (const n of [...nostrNotes, ...fromFollowCache, ...htNotes]) {
      if (!seenIds.has(n.id)) { allNostr.push(n); seenIds.add(n.id); }
    }

    debugLog('[corkboard] nostrNotes:', nostrNotes.length, 'followCacheSubset:', fromFollowCache.length, 'hashtagNotes:', htNotes.length, 'rssNotes:', rss.length);

    // Merge RSS notes with Nostr+hashtag notes, filtering RSS to the time window
    if (rss.length === 0) return allNostr.sort((a, b) => b.created_at - a.created_at);

    // Determine time window from all notes for RSS filtering
    const mergedSeen = new Set(allNostr.map(n => n.id));
    const merged = [...allNostr];
    if (allNostr.length > 0) {
      // Filter RSS to the range of existing notes
      const oldest = allNostr.reduce((min, n) => n.created_at < min ? n.created_at : min, allNostr[0].created_at);
      const newest = allNostr.reduce((max, n) => n.created_at > max ? n.created_at : max, allNostr[0].created_at);
      for (const note of rss) {
        if (!mergedSeen.has(note.id) && note.created_at >= oldest && note.created_at <= newest) {
          mergedSeen.add(note.id);
          merged.push(note);
        }
      }
    } else {
      // No nostr/hashtag notes — show all RSS items
      for (const note of rss) {
        if (!mergedSeen.has(note.id)) {
          mergedSeen.add(note.id);
          merged.push(note);
        }
      }
    }
    return merged.sort((a, b) => b.created_at - a.created_at);
  }, [isCustomFeedTab, activeCustomFeed, customFeedNotesData, hashtagNotes, extraHashtagNotes, customFeedRssNotes, followNotesCache, showOwnNotes, user?.pubkey]);
  const _isLoadingCorkboardNotes = isLoadingFollowCache && isCustomFeedTab;



  useEffect(() => {
    if (followsData) {
      setAvailableFollows(followsData);
    }
  }, [followsData]);

  // Fetch NIP-65 relays for user and contacts (outbox model)
  useEffect(() => {
    if (user?.pubkey) {
      // Fetch relays for logged-in user
      fetchRelaysForPubkey(user.pubkey);
    }

    if (contacts && contacts.length > 0) {
      // Fetch relays for contacts (limit to avoid too many requests)
      // Only fetch for new contacts not already in cache
      const contactsToFetch = contacts.slice(0, 20); // Limit for performance
      fetchRelaysForMultiple(contactsToFetch);
    }
  }, [user?.pubkey, contacts, fetchRelaysForPubkey, fetchRelaysForMultiple]);

  // Auto-fetch notes for corkboard pubkeys NOT in follows when custom corkboard opens
  useEffect(() => {
    if (!isCustomFeedTab || !activeCustomFeed || !contacts) return;
    const feedPubkeys = activeCustomFeed.pubkeys || [];
    if (feedPubkeys.length === 0) return;

    const contactsSet = new Set(contacts);
    const nonFollowPubkeys = feedPubkeys.filter(p => !contactsSet.has(p));
    if (nonFollowPubkeys.length === 0) return;

    // Fetch notes from non-follow pubkeys and merge into follow cache
    const fetchNonFollowNotes = async () => {
      debugLog('[customFeed] Fetching notes for', nonFollowPubkeys.length, 'non-follow pubkeys');
      try {
        const signal = AbortSignal.timeout(15000);
        const events = await nostr.query([{
          kinds: [...FEED_KINDS],
          authors: nonFollowPubkeys,
          limit: feedLimit,
        }], { signal });
        if (events.length > 0) {
          const { mergeNotesToCache } = await import('@/lib/notesCache');
          await mergeNotesToCache(events);
          debugLog('[customFeed] Merged', events.length, 'notes from non-follow pubkeys');
        }
      } catch (e) {
        debugLog('[customFeed] Failed to fetch non-follow notes:', e);
      }
    };
    fetchNonFollowNotes();
  }, [isCustomFeedTab, activeCustomFeed, contacts, nostr, feedLimit]);

  // Keep profileModalState in sync for ProfileModal action buttons
  useEffect(() => {
    profileModalState.customFeeds = customFeeds.map(f => ({ id: f.id, title: f.title }));
  }, [customFeeds]);

  useEffect(() => {
    profileModalState.contacts = contacts || [];
  }, [contacts]);

  // Safe kind-3 follow-list mutation — extracted into useContactActions so this
  // data-loss-sensitive logic lives in one focused, reusable place. It re-reads
  // the authoritative list at click time, preserves petnames/relay hints/content,
  // and refuses a removal it can't confirm. See useContactActions / @core/contactList.
  const safeUpdateContacts = useContactActions(user, contacts);

  // Listen for profile action events
  useEffect(() => {
    const handleNewCorkboard = (e: Event) => {
      const { pubkey } = (e as CustomEvent<ProfileActionDetail>).detail;
      const cachedAuthor = queryClient.getQueryData<{ metadata?: { display_name?: string; name?: string } }>(['author', pubkey]);
      const nickname = cachedAuthor?.metadata?.display_name || cachedAuthor?.metadata?.name || genUserName(pubkey);
      const newFeed = {
        id: Date.now().toString(),
        title: nickname,
        pubkeys: [pubkey],
        relays: [],
        rssUrls: [],
        // No filters - shows all notes by default
      };
      setCustomFeeds(prev => [...prev, newFeed]);
      setActiveTab(`feed:${newFeed.id}`);
      toast({ title: 'Corkboard created', description: `New corkboard for ${newFeed.title}` });
    };

    const handleAddToCorkboard = (e: Event) => {
      const { pubkey, feedId } = (e as CustomEvent<ProfileActionDetail>).detail;
      if (!feedId) return;
      const feed = customFeeds.find(f => f.id === feedId);
      if (feed?.pubkeys.includes(pubkey)) {
        toast({ title: 'Already on this corkboard' });
        return;
      }
      setCustomFeeds(prev => prev.map(f => {
        if (f.id !== feedId) return f;
        return { ...f, pubkeys: [...f.pubkeys, pubkey] };
      }));
      toast({ title: 'Added to corkboard' });
    };

    const handleFollow = (e: Event) => {
      const { pubkey } = (e as CustomEvent<ProfileActionDetail>).detail;
      if (!user?.pubkey) return;
      void safeUpdateContacts({ add: pubkey }, { title: 'Followed', description: 'Contact list updated' });
    };

    const handleUnfollow = (e: Event) => {
      const { pubkey } = (e as CustomEvent<ProfileActionDetail>).detail;
      if (!user?.pubkey) return;
      void safeUpdateContacts({ remove: pubkey }, { title: 'Unfollowed', description: 'Contact list updated' });
    };

    const handleMute = async (e: Event) => {
      const { pubkey } = (e as CustomEvent<ProfileActionDetail>).detail;
      try {
        await mutePubkey(pubkey);
        toast({ title: 'Muted', description: 'Mute list updated on relays' });
      } catch (err) {
        toast({ title: 'Mute failed', description: String(err), variant: 'destructive' });
      }
    };

    window.addEventListener(PROFILE_ACTION_NEW_CORKBOARD, handleNewCorkboard);
    window.addEventListener(PROFILE_ACTION_ADD_TO_CORKBOARD, handleAddToCorkboard);
    window.addEventListener(PROFILE_ACTION_FOLLOW, handleFollow);
    window.addEventListener(PROFILE_ACTION_UNFOLLOW, handleUnfollow);
    window.addEventListener(PROFILE_ACTION_MUTE, handleMute);

    return () => {
      window.removeEventListener(PROFILE_ACTION_NEW_CORKBOARD, handleNewCorkboard);
      window.removeEventListener(PROFILE_ACTION_ADD_TO_CORKBOARD, handleAddToCorkboard);
      window.removeEventListener(PROFILE_ACTION_FOLLOW, handleFollow);
      window.removeEventListener(PROFILE_ACTION_UNFOLLOW, handleUnfollow);
      window.removeEventListener(PROFILE_ACTION_MUTE, handleMute);
    };
  }, [contacts, user?.pubkey, createEvent, queryClient, toast, setCustomFeeds, setActiveTab, mutePubkey, customFeeds, safeUpdateContacts]);





  const hasActiveContentFilters = hasActiveContentFiltersFor(feedContentFilterConfig);
  const hasActiveFilters = kindFilters.size > 0 || hashtagFilters.size > 0 || hasActiveContentFilters;

  const discoverStats = useMemo(() => computeNoteKindStats(discoveredNotes), [discoveredNotes]);

  // ─── Feed pagination (load older / load newer) ───────────────────────────
  // currentNotes for the hook: we use a ref to avoid creating a circular
  // dependency (notes → newerNotes → pagination). The ref is updated after each
  // render so load-newer deduplication always sees the latest displayed notes.
  const currentNotesRef = useRef<NostrEvent[]>([]);
  // Tracks, per tab, whether we've ever displayed other-author notes. Guards the
  // "include my notes" empty-feed fallback so a transient post-idle empty (cold
  // relays on resume) doesn't collapse the feed to only the user's own (often
  // stale) notes until they press "newer". Reset on user change.
  const otherAuthorsSeenRef = useRef<Record<string, boolean>>({});
  // Alias for hook param — will always be the ref's current array.
  // This intentionally passes the same reference; React won't re-run the hook
  // when this changes (it's just for callback closures inside the hook).
  const _currentNotesForPagination = currentNotesRef.current;

  const {
    hasMore,
    isLoadingMore,
    isLoadingNewer,
    loadingMessage,
    newerNotes,
    freshNoteIds,
    newestTimestamp: _newestTimestamp,
    lastFetchTime,
    batchProgress,
    scrollTargetNoteId,
    clearScrollTarget,
    loadMoreNotes,
    loadMoreByCount,
    loadNewerNotes,
    setBatchProgress: _paginationSetBatchProgressInternal,
    hoursLoaded,
  } = useFeedPagination({
    activeTab,
    userPubkey: user?.pubkey,
    contacts,
    activeCustomFeed,
    limit: feedLimit,
    multiplier: feedLimitMultiplier,
    currentNotes: _currentNotesForPagination,
    userNotes,
    allFollowsNotes,
    customFeedNotes: corkboardNotes, // follow-cache subset for timestamp calculations
    friendNotes,
    onMeTabNotesLoaded: handleMeTabNotesLoaded,
    onUserNotesFetched: handleUserNotesFetched,
    showOwnNotes,
    isDismissed,
  });

  // Wire the pagination setBatchProgress to the stable ref so feed hooks can call it
  useEffect(() => {
    batchProgressCallbackRef.current = _paginationSetBatchProgressInternal;
  }, [_paginationSetBatchProgressInternal]);

  // Fetching new notes is also the right moment to re-attempt anything on
  // screen that never resolved: whatever was wrong — a slow relay, a socket
  // budget that was momentarily exhausted — has usually passed by the time the
  // next fetch runs, and the user is already looking at the result. The sweep's
  // own guards (threshold, in-flight, interval, hidden) decide whether it
  // actually does anything, so this is safe to call on every fetch.
  const loadNewerAndRetry = useCallback(() => {
    void loadNewerNotes();
    sweepUnresolved();
  }, [loadNewerNotes, sweepUnresolved]);

  // Autofetch extracted into useAutoFetch — interval, visibility gating,
  // and tab-switch re-trigger all live there. Three relay-storm bugs traced
  // to inline autofetch; centralizing makes regressions less likely.
  const { lastAutofetchTime } = useAutoFetch({
    enabled: !!autofetch,
    intervalSecs: autofetchIntervalSecs,
    activeTab,
    isLoadingAny: isLoadingMore || isLoadingNewer,
    loadNewer: loadNewerAndRetry,
  });

  // Track when RSS should be refetched (for load more functionality)
  const [rssRefetchTrigger, setRssRefetchTrigger] = useState(0);

  // Trigger RSS fetch when custom feed tab becomes active
  useEffect(() => {
    if (hasRssInCustomFeed && canLoadNotes && !customFeedRssNotes) {
      setIsCustomRssLoading(true);
      refetchCustomRss().finally(() => {
        setIsCustomRssLoading(false);
      });
    }
  }, [hasRssInCustomFeed, canLoadNotes, customFeedRssNotes, refetchCustomRss]);

  // Refetch RSS when load more is clicked
  useEffect(() => {
    if (hasRssInCustomFeed && rssRefetchTrigger > 0) {
      setIsCustomRssLoading(true);
      refetchCustomRss().finally(() => {
        setIsCustomRssLoading(false);
      });
    }
  }, [hasRssInCustomFeed, rssRefetchTrigger, refetchCustomRss]);

// Wrapper function for load more - uses appropriate loader for each tab type
  const handleLoadMore = useCallback((hours: number) => {
    if (isCustomFeedTab) {
      // Use custom feed's separate loadOlder function
      loadCustomFeedOlder();
      // Also refetch RSS if this feed has RSS URLs
      if (hasRssInCustomFeed) {
        setRssRefetchTrigger(prev => prev + 1);
      }
    } else {
      // Use the general pagination for other tabs
      loadMoreNotes(hours);
    }
  }, [loadMoreNotes, loadCustomFeedOlder, isCustomFeedTab, hasRssInCustomFeed]);

  // "Finding undismissed" state — only triggered from +25/+100 clicks when all
  // fetched notes are already dismissed. NOT auto-triggered by manual dismissal.
  const [findingUndismissed, setFindingUndismissed] = useState(false);

  // Bumped after a +25/+100 load so FeedGrid grows its render window to reveal the
  // just-loaded (older) notes — otherwise they stay sliced off below the fold until
  // a scroll or Consolidate. See FeedGrid revealMoreTick.
  const [revealMoreTick, setRevealMoreTick] = useState(0);
  const allDismissedRef = useRef(false);

  // Wrapper for count-based load more (+25, +100) — handles hashtag/RSS-only feeds
  const handleLoadMoreByCount = useCallback(async (count: number) => {
    if (isDiscoverTab) {
      loadMoreDiscover();
      return;
    }
    if (isCustomFeedTab && activeCustomFeed) {
      const hasPubkeys = (activeCustomFeed.pubkeys?.length ?? 0) > 0;
      const hasHashtags = (activeCustomFeed.hashtags?.length ?? 0) > 0;
      const hasRss = (activeCustomFeed.rssUrls?.length ?? 0) > 0;

      // Widen EVERY source this corkboard uses — not just one. Previously this
      // only paginated hashtags/RSS when there were NO pubkeys, so a mixed board
      // (npubs + hashtags + RSS) only ever loaded more author notes and hashtag/
      // RSS notes never appeared beyond their initial window. We optimize for
      // never missing notes, so load more from all of them.
      if (hasHashtags) {
        const allCurrent = [...(hashtagNotes ?? []), ...extraHashtagNotes];
        const oldest = allCurrent.length > 0
          ? allCurrent.reduce((min, n) => n.created_at < min ? n.created_at : min, allCurrent[0].created_at)
          : Math.floor(Date.now() / 1000);
        const until = oldest - 1;
        try {
          const { fetchByHashtags } = await import('@/lib/feedUtils');
          const older = await fetchByHashtags({
            nostr, hashtags: activeCustomFeed.hashtags ?? [], limit: count, since: 0, until,
          });
          if (older.length > 0) {
            setExtraHashtagNotes(prev => {
              const seen = new Set(prev.map(n => n.id));
              return [...prev, ...older.filter(n => !seen.has(n.id))];
            });
          }
        } catch { /* ignore */ }
      }
      if (hasRss) {
        setRssRefetchTrigger(prev => prev + 1);
      }
      // Authors: fall through to the shared count-based loader below. It ITERATES
      // (walking the `until` cursor back contiguously via dedupBatch) until it has
      // accumulated ~`count` NEW notes — so +25/+100 actually load 25/100, cross
      // gaps without skipping, and never miss notes. The single-window
      // loadCustomFeedOlder ignored `count` and only ever fetched one batch, which
      // is why the buttons "loaded just a few more, with gaps".
      if (!hasPubkeys) {
        setRevealMoreTick(t => t + 1); // reveal any hashtag/RSS notes just appended
        return;
      }
    }
    // For feeds with pubkeys or non-custom tabs, use the normal count-based loader.
    // Retry with increasing batch sizes if all fetched notes are already dismissed,
    // up to 3 attempts (25 → 50 → 100) to find undismissed notes.
    const MAX_RETRIES = 3;
    let batchSize = count;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await loadMoreByCount(batchSize);
      // Check if we found any undismissed notes in the updated view
      // (allDismissed is reactive but we can't read it mid-callback — check notes directly)
      await new Promise(r => setTimeout(r, 50)); // let React re-render
      if (!allDismissedRef.current) break;
      // All notes still dismissed — retry with a larger batch
      if (attempt === 0) setFindingUndismissed(true);
      batchSize = Math.min(batchSize * 2, 200);
    }
    setFindingUndismissed(false);
    // Reveal what we just loaded (older notes appended below the fold).
    setRevealMoreTick(t => t + 1);
  }, [isDiscoverTab, loadMoreDiscover, isCustomFeedTab, activeCustomFeed, loadMoreByCount, hashtagNotes, extraHashtagNotes, nostr]);

  // Calculate IndexedDB stats for the current tab
  const _indexedDbStats = useMemo(() => {
    let baseStats;
    if (activeTab === 'me' && user?.pubkey) {
      // For "me" tab, count from userNotes (React Query cache) + follow cache + pinned notes
      const followCacheStats = getCacheStatsForPubkeys([user.pubkey]);
      const userNotesCount = userNotes?.length || 0;
      const pinnedCount = pinnedNoteEvents?.length || 0;
      baseStats = {
        total: followCacheStats.total + userNotesCount + pinnedCount,
        visible: followCacheStats.visible + userNotesCount + pinnedCount,
        dismissed: followCacheStats.dismissed,
        filtered: followCacheStats.filtered,
      };
    } else if (isCustomFeedTab && activeCustomFeed) {
      baseStats = getCacheStatsForPubkeys(activeCustomFeed.pubkeys || []);
    } else if (isAllFollowsTab && contacts) {
      const pubkeys = [...contacts];
      if (user?.pubkey && !pubkeys.includes(user.pubkey)) {
        pubkeys.push(user.pubkey);
      }
      baseStats = getCacheStatsForPubkeys(pubkeys);
    } else if (isFriendTab) {
      baseStats = getCacheStatsForPubkeys([activeTab]);
    } else {
      baseStats = { total: 0, visible: 0, dismissed: 0, filtered: 0 };
    }

    // Add newerNotes to the count (they're not in IndexedDB yet but are visible)
    if (newerNotes.length > 0) {
      let addedVisible = 0;
      let addedTotal = 0;

      // Determine which pubkeys to check for this tab
      let relevantPubkeys: string[] = [];
      if (activeTab === 'me' && user?.pubkey) {
        relevantPubkeys = [user.pubkey];
      } else if (isCustomFeedTab && activeCustomFeed) {
        relevantPubkeys = activeCustomFeed.pubkeys || [];
      } else if (isAllFollowsTab && contacts) {
        relevantPubkeys = [...contacts];
        if (user?.pubkey && !relevantPubkeys.includes(user.pubkey)) {
          relevantPubkeys.push(user.pubkey);
        }
      } else if (isFriendTab) {
        relevantPubkeys = [activeTab];
      }
      
      const pubkeySet = new Set(relevantPubkeys);
      for (const note of newerNotes) {
        if (pubkeySet.has(note.pubkey)) {
          addedTotal++;
          // For simplicity, count all newerNotes as visible
          // They haven't been through Stage 2 filtering yet
          addedVisible++;
        }
      }
      
      return {
        total: baseStats.total + addedTotal,
        visible: baseStats.visible + addedVisible,
        dismissed: baseStats.dismissed,
        filtered: baseStats.filtered,
      };
    }
    
    return baseStats;
  }, [activeTab, user?.pubkey, isCustomFeedTab, activeCustomFeed, isAllFollowsTab, isFriendTab, contacts, newerNotes, userNotes?.length, pinnedNoteEvents?.length]);

  // Custom feed notes: use corkboardNotes (follow cache filtered by corkboard pubkeys + RSS)
  // No relay queries - just filter from what's already fetched in follow-notes-cache
  const customFeedNotes = corkboardNotes;

  // Stats computed directly from query data (now that customFeedNotes is filtered)
  // activeTabStats is computed from deduplicatedNotes (Stage 1 output) below,
  // so kind-toggle counts reflect the actual deduped set, not raw cache sizes.

  // Classify and prepare notes for display
  // ── Stage 1: Deduplicate & classify (only re-runs when source data changes) ──
  const { deduplicatedNotes, noteClassifications, parentIdsNeeded, eventLookup, engagementByTarget, stubNoteIds } = useMemo(() => {
    let baseNotes: NostrEvent[] | undefined;
    if (activeTab === 'me') {
      baseNotes = userNotes;
    } else if (isRelayTab) {
      baseNotes = relayNotes;
    } else if (isCustomFeedTab) {
      baseNotes = customFeedNotes;
    } else if (isDiscoverTab) {
      baseNotes = stableDiscoverNotes;
    } else if (isAllFollowsTab) {
      baseNotes = allFollowsNotes;
    } else if (isRssTab) {
      // Filter RSS items to the time window of loaded follow notes so they
      // appear chronologically consistent with other tabs.
      if (rssNotes && allFollowsNotes && allFollowsNotes.length > 0) {
        const oldest = allFollowsNotes.reduce((min, n) => n.created_at < min ? n.created_at : min, allFollowsNotes[0].created_at);
        const newest = allFollowsNotes.reduce((max, n) => n.created_at > max ? n.created_at : max, allFollowsNotes[0].created_at);
        baseNotes = rssNotes.filter(n => n.created_at >= oldest && n.created_at <= newest);
      } else {
        baseNotes = rssNotes;
      }
    } else {
      baseNotes = friendNotes;
    }

    if (newerNotes.length > 0) {
      baseNotes = [...newerNotes, ...(baseNotes || [])];
    }

    if (!baseNotes || baseNotes.length === 0) {
      const hasPinnedOnMe = activeTab === 'me' && pinnedNoteEvents && pinnedNoteEvents.length > 0;
      const canShowOwnNotes = showOwnNotes && activeTab !== 'me' && !isDiscoverTab && user?.pubkey;
      if (hasPinnedOnMe) {
        baseNotes = [];
      } else if (!canShowOwnNotes) {
        return { deduplicatedNotes: [] as NostrEvent[], noteClassifications: new Map<string, NoteClassification>(), parentIdsNeeded: [] as string[], eventLookup: new Map<string, NostrEvent>(), engagementByTarget: new Map<string, { reactions: NostrEvent[]; reposts: NostrEvent[]; zaps: NostrEvent[] }>(), stubNoteIds: new Set<string>() };
      } else {
        baseNotes = [];
      }
    }

    if (showOwnNotes && activeTab !== 'me' && !isDiscoverTab && user?.pubkey) {
      // On custom feed tabs, don't mix in self-notes until the feed has loaded.
      // Showing only self-notes while waiting for other authors is disorienting.
      const feedStillLoading = isCustomFeedTab && isLoadingCustomFeedNotes;
      if (!feedStillLoading) {
        // Mix in self notes from follow cache AND userNotes (me-tab source) for reliability.
        // followNotesCache may not always include self notes (relay timing, batch ordering).
        // Own PINNED notes stay eligible here — pinning must not remove a note
        // from "include my notes" feeds. userNotes drops fetched pins (they're
        // added separately on 'me'), so own pinned events are a third source.
        const selfFromCache = followNotesCache?.filter(e => e.pubkey === user.pubkey) ?? [];
        const selfFromUserNotes = userNotes ?? [];
        const selfFromPinned = pinnedNoteEvents?.filter(e => e.pubkey === user.pubkey) ?? [];
        // Merge all sources, dedup by id
        const selfIds = new Set<string>();
        const allSelfNotes: NostrEvent[] = [];
        for (const n of [...selfFromCache, ...selfFromUserNotes, ...selfFromPinned]) {
          if (!selfIds.has(n.id)) {
            selfIds.add(n.id);
            allSelfNotes.push(n);
          }
        }
        // Define the visible window from OTHER authors' notes only — own notes
        // must never widen it. Then clamp own notes to [oldest, newest] so a
        // recently-posted (or very old) own note can't appear outside the
        // window the user is actually looking at.
        const windowNotes = baseNotes.filter(n => n.pubkey !== user.pubkey);
        if (windowNotes.length > 0 && allSelfNotes.length > 0) {
          let oldestTimestamp = windowNotes[0].created_at;
          let newestTimestamp = windowNotes[0].created_at;
          for (const n of windowNotes) {
            if (n.created_at < oldestTimestamp) oldestTimestamp = n.created_at;
            if (n.created_at > newestTimestamp) newestTimestamp = n.created_at;
          }
          const filteredUserNotes = allSelfNotes.filter(
            n => n.created_at >= oldestTimestamp && n.created_at <= newestTimestamp,
          );
          baseNotes = [...baseNotes, ...filteredUserNotes];
        } else if (windowNotes.length === 0 && allSelfNotes.length > 0) {
          // Feed has no other-author notes right now. Only fall back to showing
          // the user's own notes when this tab has NEVER shown other-author
          // notes (a genuinely empty feed — e.g. a brand-new corkboard). If it
          // has shown them before, this empty is transient (cold relays after
          // idle/resume): leave the feed empty so autofetch / "load newer"
          // repopulates it, rather than collapsing to the user's own (often
          // stale, non-recent) notes until they manually press "newer".
          if (!otherAuthorsSeenRef.current[activeTab]) {
            baseNotes = [...allSelfNotes];
          }
          // else: keep baseNotes empty; the feed will refill on the next fetch.
        }
      }
    }

    // Only include pinned notes on 'me' tab; exclude them from all other tabs —
    // EXCEPT the user's own pinned notes when "include my notes" is on: pinning
    // one of your own notes must not make it vanish from those feeds.
    // Pinned notes come FIRST so the dedup below keeps the pinned version and
    // drops any duplicate that also appears in the regular feed.
    let allNotes: NostrEvent[];
    if (activeTab === 'me') {
      allNotes = [...(pinnedNoteEvents || []), ...baseNotes];
    } else {
      allNotes = pinnedIdSet.size > 0
        ? baseNotes.filter(n => !pinnedIdSet.has(n.id) || (showOwnNotes && n.pubkey === user?.pubkey))
        : baseNotes;
    }

    // Collect deletion requests (kind 5) — build set of deleted event IDs.
    //
    // NIP-09 requires a client to verify that each event referenced by an `e`
    // tag has the SAME pubkey as the deletion request, before hiding it. Relays
    // generally cannot perform this check and are explicitly not authoritative.
    // Without it, anyone can publish `{kind:5, tags:[["e","<someone else's
    // note>"]]}` and censor arbitrary notes out of this feed.
    const authorByNoteId = new Map<string, string>();
    for (const note of allNotes) authorByNoteId.set(note.id, note.pubkey);

    const deletedNoteIds = new Set<string>();
    for (const note of allNotes) {
      if (note.kind !== 5) continue;
      for (const tag of note.tags) {
        if (tag[0] !== 'e' || !tag[1]) continue;
        // Honour the request only when the target is provably the requester's
        // own event. If we don't hold the target we cannot validate, so we
        // don't hide it — and nothing is lost, because the filter below only
        // acts on notes present in `allNotes` anyway.
        if (authorByNoteId.get(tag[1]) === note.pubkey) deletedNoteIds.add(tag[1]);
      }
    }

    const DISPLAYABLE_KINDS = new Set([1, 6, 7, 16, 20, 21, 22, 1063, 1068, 1111, 30023, 34235, 34236, 9735, 9802]);
    // Standalone "content" kinds — notes that render on their own (not engagement
    // events). Used to suppress a reaction/zap card when the note it targets is
    // already present in the feed as its own post.
    const CONTENT_KINDS = new Set([1, 20, 21, 22, 1063, 1068, 1111, 30023, 34235, 34236, 9802]);
    const displayableNotes = allNotes.filter(note =>
      note.kind !== 5 && DISPLAYABLE_KINDS.has(note.kind)
    ).filter(note => !deletedNoteIds.has(note.id))
     .filter(note => !mutedPubkeys.has(note.pubkey));

    // Build event lookup so getNoteCategories can check reaction/repost targets
    const eventLookup = new Map(displayableNotes.map(n => [n.id, n]));

    const seen = new Set<string>();
    const seenRepostedIds = new Set<string>();
    const referencedOriginalIds = new Set<string>();

    // Engagement aggregation: group reactions/reposts/zaps by target note.
    // When collapseReactions is on, engagement events are suppressed as cards
    // and instead rendered as badges on the target note.
    type EngagementEntry = { reactions: NostrEvent[]; reposts: NostrEvent[]; zaps: NostrEvent[] };
    const engagementByTarget = new Map<string, EngagementEntry>();
    const stubNoteIds = new Set<string>(); // engagement events kept as stubs (target not in feed)
    const seenEngagementTargets = new Set<string>();

    // Determine if collapsing is active for this tab
    const isMeTab = activeTab === 'me';
    const isSingleNpubTab = isFriendTab || (isCustomFeedTab && activeCustomFeed?.pubkeys?.length === 1);
    const shouldCollapse = collapseReactions && !isMeTab && !isSingleNpubTab;

    function getOrCreateEngagement(targetId: string): EngagementEntry {
      let entry = engagementByTarget.get(targetId);
      if (!entry) { entry = { reactions: [], reposts: [], zaps: [] }; engagementByTarget.set(targetId, entry); }
      return entry;
    }

    // Pre-scan to build referencedOriginalIds (used for old dedup path when collapse is off)
    for (const note of displayableNotes) {
      if (note.kind === 6 || note.kind === 16) {
        let origId: string | undefined;
        if (note.content && note.content.startsWith('{')) {
          try { origId = JSON.parse(note.content).id; } catch { /* ignore */ }
        }
        if (!origId) origId = note.tags.find(t => t[0] === 'e')?.[1];
        if (origId) referencedOriginalIds.add(origId);
      } else if (note.kind === 7 || note.kind === 9735) {
        const eTag = note.tags.find(t => t[0] === 'e');
        if (eTag?.[1]) referencedOriginalIds.add(eTag[1]);
      }
    }

    const deduped = displayableNotes.filter(note => {
      if (seen.has(note.id)) return false;
      seen.add(note.id);

      if (shouldCollapse) {
        // ── Collapse mode: aggregate engagement into badges ──

        // Reactions (kind 7) → aggregate, suppress card
        if (note.kind === 7) {
          const targetId = note.tags.find(t => t[0] === 'e')?.[1];
          if (targetId) {
            getOrCreateEngagement(targetId).reactions.push(note);
            // If target is in feed, just suppress. If not, first one becomes a stub.
            if (eventLookup.has(targetId)) return false;
            if (seenEngagementTargets.has(targetId)) return false;
            seenEngagementTargets.add(targetId);
            stubNoteIds.add(note.id);
            return true; // keep as stub
          }
        }

        // Zaps (kind 9735) → aggregate, suppress card
        if (note.kind === 9735) {
          const targetId = note.tags.find(t => t[0] === 'e')?.[1];
          if (targetId) {
            getOrCreateEngagement(targetId).zaps.push(note);
            if (eventLookup.has(targetId)) return false;
            if (seenEngagementTargets.has(targetId)) return false;
            seenEngagementTargets.add(targetId);
            stubNoteIds.add(note.id);
            return true;
          }
        }

        // Reposts (kind 6/16) → aggregate, suppress card
        if (note.kind === 6 || note.kind === 16) {
          let originalId: string | undefined;
          if (note.content && note.content.startsWith('{')) {
            try { originalId = JSON.parse(note.content).id; } catch { /* ignore */ }
          }
          if (!originalId) originalId = note.tags.find(t => t[0] === 'e')?.[1];
          if (originalId) {
            getOrCreateEngagement(originalId).reposts.push(note);
            if (eventLookup.has(originalId) || seen.has(originalId)) return false;
            if (seenEngagementTargets.has(originalId)) return false;
            seenEngagementTargets.add(originalId);
            stubNoteIds.add(note.id);
            return true;
          }
        }

        // Quote notes (kind 1 with q-tags) → suppress from feed (shown in threads)
        // Exception: pinned notes are never suppressed
        if (note.kind === 1 && note.tags.some(t => t[0] === 'q') && !pinnedIdSet.has(note.id)) {
          return false;
        }

        // Original note that has engagement: if a stub was already placed, suppress the stub
        // by letting the original take its place (stub will be filtered downstream or replaced)
        if ((note.kind === 1 || note.kind === 30023) && seenEngagementTargets.has(note.id)) {
          // Original arrived — remove stub marker, original takes over
          seenEngagementTargets.delete(note.id);
        }

        // Regular notes pass through
        return true;
      } else {
        // ── Legacy mode (collapse off): original dedup + still build engagement map ──
        // Cards are NOT suppressed, but engagement data is still collected so
        // badges can show on original notes (e.g. single-npub corkboards).

        if (note.kind === 7) {
          const targetId = note.tags.find(t => t[0] === 'e')?.[1];
          if (targetId) getOrCreateEngagement(targetId).reactions.push(note);
          // Suppress the reaction card when the note it targets is already in the
          // feed as its own post (any content kind) — the reaction is redundant.
          const target = targetId ? eventLookup.get(targetId) : undefined;
          if (target && CONTENT_KINDS.has(target.kind)) {
            return false;
          }
        }
        if (note.kind === 9735) {
          const targetId = note.tags.find(t => t[0] === 'e')?.[1];
          if (targetId) getOrCreateEngagement(targetId).zaps.push(note);
          const target = targetId ? eventLookup.get(targetId) : undefined;
          if (target && CONTENT_KINDS.has(target.kind)) {
            return false;
          }
        }
        if (note.kind === 6 || note.kind === 16) {
          let originalId: string | undefined;
          if (note.content && note.content.startsWith('{')) {
            try { originalId = JSON.parse(note.content).id; } catch { /* ignore */ }
          }
          if (!originalId) originalId = note.tags.find(t => t[0] === 'e')?.[1];
          if (originalId) {
            getOrCreateEngagement(originalId).reposts.push(note);
            if (seen.has(originalId) || seenRepostedIds.has(originalId)) return false;
            seenRepostedIds.add(originalId);
          }
        }
        if (note.kind === 1 && seenRepostedIds.has(note.id)) return false;
        return true;
      }
    });

    const classifications = new Map<string, NoteClassification>();
    const parentRequests = new Map<string, { eventId: string; hints: string[]; authorPubkey?: string }>();
    for (const note of deduped) {
      const c = classifyNote(note);
      classifications.set(note.id, c);
      if (c.isReply && c.parentEventId && !parentRequests.has(c.parentEventId)) {
        // Extract relay hints from e-tags and author from p-tags
        const replyETag = note.tags.find(t => t[0] === 'e' && t[1] === c.parentEventId);
        const hints = replyETag?.[2] ? [replyETag[2]] : [];
        const authorPubkey = note.tags.find(t => t[0] === 'p')?.[1];
        parentRequests.set(c.parentEventId, { eventId: c.parentEventId, hints, authorPubkey });
      }
    }

    return {
      deduplicatedNotes: deduped,
      noteClassifications: classifications,
      parentIdsNeeded: Array.from(parentRequests.values()),
      eventLookup,
      engagementByTarget,
      stubNoteIds,
    };
  }, [activeTab, userNotes, friendNotes, relayNotes, customFeedNotes, stableDiscoverNotes, allFollowsNotes, rssNotes, isRelayTab, isCustomFeedTab, isLoadingCustomFeedNotes, isDiscoverTab, isAllFollowsTab, isRssTab, pinnedNoteEvents, showOwnNotes, newerNotes, mutedPubkeys, followNotesCache, pinnedIdSet, user?.pubkey, collapseReactions, isFriendTab, activeCustomFeed?.pubkeys?.length]);

  // ── Bulk Author Prefetch ─────────────────────────────────────────────────────
  // Extracted into useBulkAuthorPrefetch — handles both the debounced "visible
  // notes" prefetch and the eager all-follows background prefetch with the
  // fingerprint guard against redundant fires.
  useBulkAuthorPrefetch({
    displayedNotes: deduplicatedNotes,
    allFollowsNotes,
    feedLimit,
    enabled: canLoadNotes,
  });

  // ── Lazy engagement fetch: query reactions/reposts/zaps for visible notes ──
  // Fires once after feed loads, single batched query, respects rate limiting.
  const lazyEngagementNoteIds = useMemo(() => {
    if (!canLoadNotes || deduplicatedNotes.length === 0) return '';
    // Collect IDs of the original notes (kind 1/30023) currently in view — the
    // targets we want engagement for. This joined list IS the query key, so we
    // sort it: the key then depends on the SET of visible target notes, not their
    // order. A feed re-sort (very common — time ordering shifts on every arrival)
    // that doesn't change WHICH notes are visible now reuses the cached result
    // instead of minting a new key, firing a fresh relay query, and leaking the
    // old cache entry. The relay treats `#e` as a set, so sorting doesn't change
    // what's fetched.
    const ids = deduplicatedNotes
      .filter(n => n.kind === 1 || n.kind === 30023)
      .slice(0, LAZY_ENGAGEMENT_TARGETS)
      .map(n => n.id);
    ids.sort();
    return ids.join(',');
  }, [canLoadNotes, deduplicatedNotes]);

  const { data: lazyEngagement } = useQuery({
    queryKey: ['lazy-engagement', lazyEngagementNoteIds],
    queryFn: async () => {
      const ids = lazyEngagementNoteIds.split(',').filter(Boolean);
      if (ids.length === 0) return [] as NostrEvent[];
      // Bound to the current view: engagement badges for notes the user has
      // already navigated away from are pure waste, so if this is still queued
      // when they switch tabs it is dropped rather than run. Safe to cancel —
      // nothing is persisted from it and it refetches on return.
      const epoch = getQueryEpoch();
      // Single batched query for all engagement on visible notes.
      //
      // The limit used to be 500. Engagement events are the highest-volume kind
      // on Nostr (reactions especially), so that ceiling was routinely reached,
      // and every returned event costs deserialization, a signature check, and a
      // pass through mergedEngagementByTarget below — all on the main thread. It
      // was the largest single stall in the app. This many badges never reach
      // the screen; the cap now reflects what is actually rendered.
      try {
        return await withQueryBudget(
          () => nostr.query(
            [{ kinds: [7, 9735, 6, 16], '#e': ids, limit: LAZY_ENGAGEMENT_LIMIT }],
            { signal: AbortSignal.timeout(8000) },
          ),
          { epoch },
        );
      } catch (err) {
        // Superseded by a tab switch — not an error worth surfacing or retrying.
        if (err instanceof StaleEpochError) return [] as NostrEvent[];
        throw err;
      }
    },
    enabled: lazyEngagementNoteIds.length > 0,
    staleTime: 5 * 60 * 1000, // 5 min — don't re-fetch constantly
    // Short GC: whenever the visible set changes the key changes and the old
    // entry goes inactive. A long gcTime piled those orphaned entries up in
    // memory; 2 min still covers a quick scroll-back to the same set.
    gcTime: 2 * 60 * 1000,
  });

  // Merge lazy-fetched engagement into the engagement map
  const mergedEngagementByTarget = useMemo(() => {
    if (!lazyEngagement || lazyEngagement.length === 0) return engagementByTarget;
    // Clone the map so we don't mutate the original
    const merged = new Map(engagementByTarget);
    // Per-target Set of seen ids for O(1) dedup instead of O(n) .some per event (P5).
    const seenByTarget = new Map<string, Set<string>>();
    for (const ev of lazyEngagement) {
      const targetId = ev.tags.find(t => t[0] === 'e')?.[1];
      if (!targetId) continue;
      let seen = seenByTarget.get(targetId);
      let entry = merged.get(targetId);
      if (!seen) {
        // First lazy event for this target this pass: CLONE the entry and its
        // arrays before we push. `new Map(engagementByTarget)` only shallow-copied
        // the map, so the entries are still shared with the source — mutating them
        // in place both corrupted the original map and left NoteCard's
        // reference-equality memo blind to the new engagement (same object ref).
        entry = entry
          ? { reactions: [...entry.reactions], reposts: [...entry.reposts], zaps: [...entry.zaps] }
          : { reactions: [], reposts: [], zaps: [] };
        merged.set(targetId, entry);
        seen = new Set<string>();
        for (const r of entry.reactions) seen.add(r.id);
        for (const r of entry.reposts) seen.add(r.id);
        for (const z of entry.zaps) seen.add(z.id);
        seenByTarget.set(targetId, seen);
      }
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      if (ev.kind === 7) entry!.reactions.push(ev);
      else if (ev.kind === 9735) entry!.zaps.push(ev);
      else if (ev.kind === 6 || ev.kind === 16) entry!.reposts.push(ev);
    }
    return merged;
  }, [engagementByTarget, lazyEngagement]);

  // ── Stage 2: Apply filters (re-runs when filters change, but skips dedup/classify) ──
  const { notes, filteredHashtags, hasFilteredNotes, allDismissed } = useMemo(() => {
    if (deduplicatedNotes.length === 0) {
      return { notes: [] as NostrEvent[], filteredHashtags: [] as { tag: string; count: number }[], allDismissed: false };
    }

    // Dismiss filter — skip on 'me' tab (dismissing elsewhere shouldn't hide own notes).
    // Also auto-dismiss notes that reference (reply to, react to, repost) a dismissed note,
    // so future notes arriving via autofetch are caught too.
    let filteredNotes: NostrEvent[];
    if (activeTab === 'me') {
      filteredNotes = deduplicatedNotes;
    } else {
      // Build a set of dismissed IDs for fast lookup
      const dismissedIds = new Set<string>();
      for (const note of deduplicatedNotes) {
        if (isDismissed(note.id)) dismissedIds.add(note.id);
      }
      filteredNotes = deduplicatedNotes.filter(note => {
        if (dismissedIds.has(note.id)) return false;
        // Belongs to a dismissed thread root (persisted) — hide it even if it
        // arrived after the "dismiss all associated" action, or if the root
        // itself is no longer in view.
        if (dismissedThreadRootSet.has(note.id)) return false;
        // Auto-dismiss: if this note references a dismissed note OR a dismissed
        // thread root, hide it too.
        for (const tag of note.tags) {
          if (tag[0] === 'e' && tag[1] && (dismissedIds.has(tag[1]) || dismissedThreadRootSet.has(tag[1]))) return false;
        }
        return true;
      });
    }

    // "Include my notes" toggle: when OFF, exclude user's own notes from all non-me tabs
    if (!showOwnNotes && activeTab !== 'me' && user?.pubkey) {
      filteredNotes = filteredNotes.filter(note => note.pubkey !== user.pubkey);
    }

    // Pin visibility on 'me' tab: show/hide pinned and unpinned independently
    if (activeTab === 'me') {
      if (!showPinned && pinnedIdSet.size > 0) {
        filteredNotes = filteredNotes.filter(note => !pinnedIdSet.has(note.id));
      }
      if (!showUnpinned) {
        filteredNotes = filteredNotes.filter(note => pinnedIdSet.has(note.id));
      }
    }

    // During onboard procedure on discover tab, hide replies (show only root notes)
    if (isOnboarding && isDiscoverTab) {
      filteredNotes = filteredNotes.filter(note => {
        const classification = noteClassifications.get(note.id);
        return !classification?.isReply;
      });
    }

    // Kind filters — two modes, evaluated by the shared rule in @core so web
    // and mobile agree:
    // 'any' (loose, default): keep a note when something SPECIFIC about it is
    //   still wanted (a reaction to a video survives hiding reactions). The
    //   generic shortNotes/replies/other buckets don't count as specific —
    //   letting them count is what made "hide images" a no-op, since every
    //   image post is also a short note.
    // 'strict': hide if ANY of the note's categories is disabled.
    const categoryToFilter: Record<string, KindFilter> = {
      shortNotes: 'posts', replies: 'replies', longForm: 'articles',
      videos: 'videos', images: 'images', reposts: 'reposts', reactions: 'reactions',
      highlights: 'highlights', recipes: 'recipes', other: 'posts',
    };
    if (kindFilters.size > 0) {
      filteredNotes = filteredNotes.filter(note =>
        noteMatchesKindFilters(getNoteCategories(note, eventLookup), kindFilters, categoryToFilter, filterMode)
      );
    }

    // Hashtag filters — only show notes whose hashtags match the selection.
    // Reactions/zaps check their target note's hashtags; if the target is unknown, hide them.
    // Reposts check embedded content. Regular notes check tags + inline #hashtags.
    if (hashtagFilters.size > 0) {
      filteredNotes = filteredNotes.filter(note => {
        // Reactions/zaps: check target note's hashtags
        if (note.kind === 7 || note.kind === 9735) {
          const targetId = note.tags.find(t => t[0] === 'e')?.[1];
          const target = targetId ? eventLookup?.get(targetId) : null;
          if (target) return noteMatchesHashtags(target, hashtagFilters);
          return false; // Unknown target — hide to keep results deterministic
        }
        return noteMatchesHashtags(note, hashtagFilters);
      });
    }

    // Content filters — the predicate lives in @core/contentFilters so mobile
    // evaluates exactly the same rules.
    //
    // The resolver lets the text filter read a repost's *reposted note*. Most of
    // the time that note is embedded in the repost's content and no lookup is
    // needed, but a bare envelope (just an `e` tag) is legal NIP-18 and common,
    // and there the phrase is on screen with nothing in the repost itself to
    // match. `eventLookup` covers targets that are in the feed; the fetch cache
    // covers the ones NoteCard pulled in to render the card. A target neither
    // has yet is left alone — it gets filtered on the next pass, once fetched.
    if (hasActiveContentFilters) {
      const textLower = debouncedHideExactText.trim().toLowerCase();
      const resolveEvent = (id: string) => eventLookup.get(id) ?? getCachedEvent(id);
      filteredNotes = filteredNotes.filter(note =>
        noteMatchesContentFilters(note, feedContentFilterConfig, textLower, resolveEvent)
      );
    }

    // Sort: pinned first, then by time descending — 'me' tab only. On other
    // tabs the only pinned notes that can reach here are the user's own (via
    // "include my notes"), and those flow chronologically like any other note.
    // Use the Set (O(1)) not pinnedIds.includes (O(n)) — this runs twice per
    // note in the hot path. (P4)
    const pinned = activeTab === 'me' ? filteredNotes.filter(note => pinnedIdSet.has(note.id)) : [];
    // Copy before sorting — filteredNotes can alias the deduplicatedNotes memo
    // output when no filter branch ran, and .sort() mutates in place.
    const regular = (activeTab === 'me' ? filteredNotes.filter(note => !pinnedIdSet.has(note.id)) : [...filteredNotes])
      .sort((a, b) => b.created_at - a.created_at);
    // No cap here, deliberately. Truncating this time-descending list to a fixed
    // ceiling would silently defeat "load older": past the ceiling every newly
    // fetched older page lands in the tail and is sliced straight back off, so
    // the user pages and nothing appears. The two costs this was meant to bound
    // are each bounded closer to their source instead —
    //   * unbounded growth over time: autofetch PREPENDS, and that path is capped
    //     at MAX_RETAINED_NOTES in useFeedPagination.setNewerNotes;
    //   * live DOM/CPU cost: capped by MAX_RENDER_PER_COL in FeedGrid.
    // What remains here is a plain array of event objects the user explicitly
    // asked for, which is cheap and finite.
    const finalNotes = [...pinned, ...regular];

    // Compute hashtags from filtered notes using shared helper
    const hashtagCounts = computeHashtagCounts(finalNotes);
    const computedHashtags = [...hashtagCounts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    // Check if notes existed before filtering but were filtered out
    const hasPinFilters = activeTab === 'me' && (!showPinned || !showUnpinned);
    const hasFiltersActive = kindFilters.size > 0 || hashtagFilters.size > 0 || hasActiveContentFilters || hasPinFilters;
    const hasFilteredNotes = deduplicatedNotes.length > 0 && finalNotes.length === 0 && hasFiltersActive;
    // Check if all notes were dismissed/consolidated (notes existed but user processed them all)
    const allDismissed = deduplicatedNotes.length > 0 && finalNotes.length === 0 && !hasFiltersActive;

    return { notes: finalNotes, filteredHashtags: computedHashtags, hasFilteredNotes, allDismissed };
  }, [deduplicatedNotes, eventLookup, noteClassifications, isDismissed, dismissedThreadRootSet, isOnboarding, isDiscoverTab, kindFilters, filterMode, hashtagFilters, hasActiveContentFilters, feedContentFilterConfig, debouncedHideExactText, pinnedIdSet, showOwnNotes, showPinned, showUnpinned, activeTab, user?.pubkey]);

  // Keep allDismissed ref in sync for handleLoadMoreByCount callback
  allDismissedRef.current = allDismissed;

  // Keep the pagination hook's currentNotes ref in sync after each render
  // (runs synchronously after the useMemo above resolves notes)
  currentNotesRef.current = notes;

  // Record that this tab has shown other-author notes, so a later transient
  // empty (cold relays on resume) won't collapse the feed to only own notes.
  // In an effect, not the render body: this mutates a ref that survives across
  // renders, and a render React discards (StrictMode, a suspended transition)
  // would otherwise leave the flag set for a feed the user never actually saw.
  useEffect(() => {
    if (activeTab && notes.some(n => n.pubkey !== user?.pubkey)) {
      otherAuthorsSeenRef.current[activeTab] = true;
    }
  }, [activeTab, notes, user?.pubkey]);

  // Stats from deduped notes — these match the visible counts in the kind toggles
  const activeTabStats = useMemo(() => computeNoteKindStats(deduplicatedNotes, eventLookup), [deduplicatedNotes, eventLookup]);

  // Detect deleted/vanished authors (NIP-09 profile deletion / NIP-62 vanish)
  // across the feed's visible authors in one batched query, so their posts can
  // render a graceful "Deleted account" treatment. Provided via context below.
  const visibleAuthors = useMemo(
    () => [...new Set(deduplicatedNotes.map(n => n.pubkey).filter(p => p && p !== RSS_PUBKEY))],
    [deduplicatedNotes],
  );
  const deletedAuthors = useDeletedAuthors(visibleAuthors);

  // Batch fetch parent notes for replies
  const { data: parentNotes } = useParentNotes(canLoadNotes ? parentIdsNeeded : []);

  // Filter handlers — use functional state updates to avoid race conditions
  // during rapid toggling (two clicks between renders both read latest state).
  const handleFilterByKind = useCallback((kind: KindFilter | 'all' | 'none') => {
    if (kind === 'all') {
      updateFilterSetting('kindFilters', []);
      updateFilterSetting('hashtagFilters', []);
    } else if (kind === 'none') {
      updateFilterSetting('kindFilters', [...ALL_NOTE_KIND_FILTERS]);
    } else {
      // Functional update reads prev state — safe under concurrent toggling
      const applyToggle = (prev: TabFilterSettings): TabFilterSettings => {
        const current = new Set<KindFilter>((prev.kindFilters ?? []) as KindFilter[]);
        if (current.has(kind)) current.delete(kind); else current.add(kind);
        return { ...prev, kindFilters: Array.from(current) };
      };
      if (activeTab.startsWith('feed:')) {
        setCustomFeeds(prev => prev.map(f =>
          `feed:${f.id}` === activeTab
            ? { ...f, filterSettings: applyToggle(f.filterSettings ?? {}) }
            : f
        ));
      } else {
        setTabFilters(prev => ({
          ...prev,
          [activeTab]: applyToggle(prev[activeTab] ?? {}),
        }));
      }
    }
  }, [activeTab, updateFilterSetting, setCustomFeeds, setTabFilters]);

  const resetContentFilters = useCallback(() => {
    setHideMinChars(0);
    setHideOnlyEmoji(false);
    setHideOnlyMedia(false);
    setHideOnlyLinks(false);
    setHideHtml(false);
    setHideMarkdown(false);
    setHideExactText('');
  }, [setHideMinChars, setHideOnlyEmoji, setHideOnlyMedia, setHideOnlyLinks, setHideHtml, setHideMarkdown, setHideExactText]);

  // contentFilterUI replaced by contentFilterConfig + handleContentFilterChange
  // passed to FeedFilters / ProfileCard which render ContentFilters internally

  const handleFilterByHashtag = useCallback((hashtag: string) => {
    const lower = hashtag.toLowerCase();
    const applyToggle = (prev: TabFilterSettings): TabFilterSettings => {
      const current = new Set<string>(prev.hashtagFilters ?? []);
      if (current.has(lower)) current.delete(lower); else current.add(lower);
      return { ...prev, hashtagFilters: Array.from(current) };
    };
    if (activeTab.startsWith('feed:')) {
      setCustomFeeds(prev => prev.map(f =>
        `feed:${f.id}` === activeTab
          ? { ...f, filterSettings: applyToggle(f.filterSettings ?? {}) }
          : f
      ));
    } else {
      setTabFilters(prev => ({
        ...prev,
        [activeTab]: applyToggle(prev[activeTab] ?? {}),
      }));
    }
  }, [activeTab, setCustomFeeds, setTabFilters]);



  // Count of blank spaces (white squares) in the grid - per corkboard only
  // White squares = collapsed notes (saved for later) + soft-dismissed notes (dismissed but not consolidated)
  const [notifBlankCount, setNotifBlankCount] = useState(0);
  const blankSpaceCount = useMemo(() => {
    if (isNotificationsTab) return notifBlankCount;
    return notes.filter(n => isCollapsedThisSession(n.id) || isSoftDismissed(n.id)).length;
  }, [isNotificationsTab, notifBlankCount, notes, isCollapsedThisSession, isSoftDismissed]);

  // Scroll to a note by ID with retry logic for mobile.
  // After consolidate or fetch, React re-renders can take longer on mobile;
  // we retry with escalating delays until the element is found and visible.
  const scrollToNote = useCallback((noteId: string) => {
    let attempts = 0;
    const delays = [50, 100, 200, 400, 800]; // escalating: total ~1.5s
    const tryScroll = () => {
      const el = document.querySelector(`[data-note-id="${noteId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (attempts < delays.length) {
        setTimeout(tryScroll, delays[attempts]);
        attempts++;
      }
    };
    requestAnimationFrame(tryScroll);
  }, []);

  // Dismiss a note and all associated notes (replies to it, parent, reactions, reposts)
  const handleDismissThread = useCallback((noteId: string) => {
    const ids = new Set<string>();
    ids.add(noteId);

    // Thread roots to remember so members loaded LATER are hidden too. Includes
    // the clicked note itself (it may BE a root) plus any root/parent it tags.
    const threadRoots = new Set<string>([noteId]);

    // Find the root/parent of the clicked note
    const clickedNote = eventLookup.get(noteId);
    if (clickedNote) {
      // Add parent (note this is a reply to)
      const parentTag = clickedNote.tags.find(t => t[0] === 'e' && (t[3] === 'reply' || t[3] === 'root'));
      if (parentTag?.[1]) { ids.add(parentTag[1]); threadRoots.add(parentTag[1]); }
      // Add root
      const rootTag = clickedNote.tags.find(t => t[0] === 'e' && t[3] === 'root');
      if (rootTag?.[1]) { ids.add(rootTag[1]); threadRoots.add(rootTag[1]); }
    }

    // Scan all visible notes for associations
    for (const note of deduplicatedNotes) {
      // Replies TO the target note or its parent/root
      if (note.kind === 1 || note.kind === 30023) {
        const eTags = note.tags.filter(t => t[0] === 'e');
        for (const tag of eTags) {
          if (tag[1] && ids.has(tag[1])) { ids.add(note.id); break; }
        }
      }
      // Reactions/zaps targeting any note in the set
      if (note.kind === 7 || note.kind === 9735) {
        const targetId = note.tags.find(t => t[0] === 'e')?.[1];
        if (targetId && ids.has(targetId)) ids.add(note.id);
      }
      // Reposts of any note in the set
      if (note.kind === 6 || note.kind === 16) {
        let origId: string | undefined;
        if (note.content?.startsWith('{')) { try { origId = JSON.parse(note.content).id; } catch { /* not JSON */ } }
        if (!origId) origId = note.tags.find(t => t[0] === 'e')?.[1];
        if (origId && ids.has(origId)) ids.add(note.id);
      }
    }

    // Also dismiss engagement from the merged map
    for (const targetId of [...ids]) {
      const eng = mergedEngagementByTarget.get(targetId);
      if (eng) {
        for (const r of eng.reactions) ids.add(r.id);
        for (const r of eng.reposts) ids.add(r.id);
        for (const z of eng.zaps) ids.add(z.id);
      }
    }

    // Persist the thread roots so the feed filter also hides members that
    // arrive after this dismissal (autofetch / load-more / navigation).
    dismissThreadRoots(Array.from(threadRoots));

    dismissMultiple(Array.from(ids), noteId);
  }, [deduplicatedNotes, eventLookup, mergedEngagementByTarget, dismissMultiple, dismissThreadRoots]);

  const consolidateSoundRef = useRef(consolidateSound);
  consolidateSoundRef.current = consolidateSound;
  const soundAccelerateRef = useRef(soundAccelerate);
  soundAccelerateRef.current = soundAccelerate;

  // Consolidate wrapper: find the first visible note after the last blank, then consolidate and scroll
  const consolidate = useCallback(() => {
    // Find the last blank note's index, then the first real note after it
    let lastBlankIdx = -1;
    for (let i = 0; i < notes.length; i++) {
      if (isCollapsedThisSession(notes[i].id) || isSoftDismissed(notes[i].id)) {
        lastBlankIdx = i;
      }
    }
    // The note right after the last blank is the scroll target
    let scrollTargetId: string | null = null;
    if (lastBlankIdx >= 0) {
      for (let i = lastBlankIdx + 1; i < notes.length; i++) {
        if (!isCollapsedThisSession(notes[i].id) && !isSoftDismissed(notes[i].id)) {
          scrollTargetId = notes[i].id;
          break;
        }
      }
    }
    // Play consolidate sound effect. Fire-and-forget: the shared AudioContext
    // may need resuming first, and the visual consolidate must not wait on audio.
    const actualBlanks = notes.filter((n, i) => i <= lastBlankIdx && (isCollapsedThisSession(n.id) || isSoftDismissed(n.id))).length;
    void playConsolidateSound(consolidateSoundRef.current, actualBlanks, soundAccelerateRef.current);
    rawConsolidate();
    if (scrollTargetId) scrollToNote(scrollTargetId);
  }, [notes, isCollapsedThisSession, isSoftDismissed, rawConsolidate, scrollToNote]);

  // Scroll to oldest newly loaded note after fetch completes
  // Suppressed briefly after tab switch so it doesn't override the restored position
  // Suppressed when autofetch is on so periodic fetches don't interrupt manual scrolling
  // (unless autoScrollTop is enabled — handled separately below)
  useEffect(() => {
    if (scrollTargetNoteId) {
      if (autofetch || Date.now() < suppressScrollTargetUntil.current) {
        clearScrollTarget();
        return;
      }
      scrollToNote(scrollTargetNoteId);
      clearScrollTarget();
    }
  }, [scrollTargetNoteId, scrollToNote, clearScrollTarget, autofetch]);

  // Auto-consolidate and/or scroll to top when new notes arrive.
  //
  // Both toggles say "when new notes arrive", and that's what they now do. They
  // used to additionally require autofetch to be ON, so pressing "newer" by hand
  // — the way most people load notes — never triggered either one, which is why
  // auto-consolidate looked broken.
  //
  // The blank count is read through a ref at fire time rather than captured in
  // the closure: it's re-derived a render or two after the new notes land, and
  // the stale value could be 0 exactly when the consolidate was wanted. The ref
  // also keeps it out of the dep array, so the effect stops re-running (and
  // re-baselining prevFreshCountRef) every time a note is dismissed.
  const blankSpaceCountRef = useRef(blankSpaceCount);
  blankSpaceCountRef.current = blankSpaceCount;
  const prevFreshCountRef = useRef(freshNoteIds.size);
  useEffect(() => {
    const prevCount = prevFreshCountRef.current;
    prevFreshCountRef.current = freshNoteIds.size;
    // Only trigger when fresh notes increased (new notes arrived)
    if (freshNoteIds.size <= prevCount) return;
    if (autoConsolidate) {
      // Delay slightly so DOM settles before consolidating
      setTimeout(() => {
        if (blankSpaceCountRef.current > 0) rawConsolidate();
      }, 150);
    }
    if (autoScrollTop) {
      setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), autoConsolidate ? 300 : 150);
    }
  }, [freshNoteIds.size, autoConsolidate, autoScrollTop, rawConsolidate]);

  // (findingUndismissed state + allDismissedRef declared earlier, before notes derivation)

  // Round-robin distribution: note 1→col 1, note 2→col 2, etc.
  // Keeps adjacent timestamps aligned across columns without height estimation.
  const columns = useMemo(() => {
    const cols: NostrEvent[][] = Array.from({ length: columnCount }, () => []);
    for (let i = 0; i < notes.length; i++) {
      cols[i % columnCount].push(notes[i]);
    }
    return cols;
  }, [notes, columnCount]);

  // Feed stats for the StatusBar, memoized. It was an inline IIFE in the JSX,
  // so it recomputed an O(deduplicatedNotes) scan AND allocated a fresh object on
  // every render (including every StatusBar timer tick), defeating the bar's memo.
  const feedStats = useMemo(() => {
    const visible = notes.length;
    const dismissed = deduplicatedNotes.filter(n => isDismissed(n.id)).length;
    const filtered = hasActiveFilters ? Math.max(0, deduplicatedNotes.length - notes.length - dismissed) : 0;
    return { total: visible + dismissed + filtered, visible, dismissed, filtered };
  }, [notes, deduplicatedNotes, isDismissed, hasActiveFilters]);

  const isLoading = isLoadingUserNotes || isLoadingFriendNotes || isLoadingRelayNotes || isLoadingCustomFeed || (isDiscoverTab && isLoadingDiscover && discoveredNotes.length === 0 && (!isOnboarding || isLoadingOnboardSeed)) || (isAllFollowsTab && isLoadingAllFollows);

  // Logout splash — must come before !user check so it stays visible after
  // nuclearWipe() removes the login (user becomes null) and until page reloads.
  if (logoutStep) {
    const isDone = logoutStep === 'done';
    const visibleLogs = logoutLog.slice(-12);
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center z-50">
        <div className="text-center space-y-4 max-w-md px-4 w-full">
          <div className={`flex justify-center ${isDone ? '' : 'animate-bounce'}`}>
            <BrandLogo className="h-10 w-auto" />
          </div>
          <h2 className="text-xl font-bold text-purple-600 dark:text-purple-400">
            {isDone ? 'Signed out' : 'Logging out'}
          </h2>
          {!isDone && (
            <div className="flex items-center justify-center gap-2">
              <div className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
            </div>
          )}
          {isDone && <div className="text-green-500 text-2xl">✓</div>}
          <div className="text-left space-y-0.5 min-h-[140px] max-h-[200px] overflow-hidden flex flex-col justify-end px-2">
            {visibleLogs.map((entry, i) => {
              const age = visibleLogs.length - 1 - i;
              const opacity = age === 0 ? 1 : age < 3 ? 0.7 : age < 6 ? 0.4 : age < 9 ? 0.2 : 0.1;
              return (
                <p
                  key={i}
                  className="text-[11px] font-mono text-muted-foreground transition-opacity duration-300 leading-tight"
                  style={{ opacity }}
                >
                  {entry}
                </p>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground italic pt-6 transition-opacity duration-500">
            {TIPS[logoutTipIndex]}
          </p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <WelcomePage />;
  }

  // If account was deleted, show a warning and block the app
  if (accountDeleted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="w-full max-w-sm space-y-4 text-center">
          <Trash2 className="h-12 w-12 text-red-500 mx-auto" />
          <h2 className="text-xl font-bold text-red-500">Account Deleted</h2>
          <p className="text-sm text-muted-foreground">
            This account was previously deleted. A deletion request (NIP-09) was found
            on relays for this identity.
          </p>
          <p className="text-xs text-muted-foreground">
            Your secret key still works, but your profile, contacts, and backup data
            have been marked for deletion. You can create a fresh profile by logging out
            and starting over with the same key, or use a different key.
          </p>
          <div className="pt-2">
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                loginActions.nuclearWipe().finally(() => window.location.replace('/'));
              }}
            >
              Log out
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // initialLoginDoneRef is declared earlier (before early returns) to respect Rules of Hooks.
  // Once the first backup check settles and user sees the main UI, splash never returns.
  if (backupCheckSettled && backupStatus !== 'checking' && backupStatus !== 'found' && backupStatus !== 'restoring') {
    initialLoginDoneRef.current = true;
  }
  const showLoginSplash = !initialLoginDoneRef.current && (!backupCheckSettled || backupStatus === 'checking' || backupStatus === 'found' || backupStatus === 'restoring');
  if (showLoginSplash) {
    return (
      <BackupSplashScreen
        backupStatus={!backupCheckSettled ? 'checking' : backupStatus}
        message={!backupCheckSettled ? 'Checking for backup...' : backupMessage}
        onDismiss={dismissRemoteBackup}
        logs={backupLogs}
      />
    );
  }

  return (
    <HashtagActionContext.Provider value={hashtagActionValue}>
    <DeletedAuthorsContext.Provider value={deletedAuthors}>
    <div className="min-h-screen bg-background">
      <div className="w-full px-4 py-0.5 pb-2 sm:py-1.5 sm:pb-4">
        {/* Header — responsive: stacked on mobile, single row on desktop */}
        {isMobile ? (
          <div className="mb-0.5">
            {/* Mobile: single row — pin, theme, settings, backup, relay | post, avatar */}
            <div className="flex items-center justify-between gap-1">
              <div className="flex items-center gap-1">
                <BrandIcon className="h-5 w-5 shrink-0 px-0.5" />
                <Button variant="ghost" size="sm" onClick={toggleTheme} className="h-7 w-7 p-0" title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
                  {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0"><Settings className="h-4 w-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => setEmojiSetsOpen(true)} className="gap-2"><Smile className="h-4 w-4" />Emoji Sets</DropdownMenuItem>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="gap-2">
                        <Volume2 className="h-4 w-4" />Sound: {consolidateSound === 'solitaire' ? 'Solitaire' : consolidateSound === 'chimes' ? 'Chimes' : 'Off'}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {[
                          { val: 'solitaire', label: 'Solitaire' },
                          { val: 'chimes', label: 'Chimes' },
                          { val: 'off', label: 'Off' },
                        ].map(opt => (
                          <DropdownMenuItem key={opt.val} onClick={() => setConsolidateSound(opt.val)}>
                            {consolidateSound === opt.val ? '✓ ' : '\u2003'}{opt.label}
                          </DropdownMenuItem>
                        ))}
                        {consolidateSound !== 'off' && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => setSoundAccelerate(!soundAccelerate)}>
                              {'\u2003'}{soundAccelerate ? 'Accelerate' : 'Shuffle'}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="gap-2">
                        <SlidersHorizontal className="h-4 w-4" />Throughput: {activeThroughputPreset ? `${activeThroughputPreset}x` : 'Custom'}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {([1, 2, 3] as const).map(tier => (
                          <DropdownMenuItem key={tier} onClick={() => applyThroughputPreset(tier)}>
                            {activeThroughputPreset === tier ? '✓ ' : '\u2003'}{tier}x
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setCustomSettingsOpen(true)}>
                          {activeThroughputPreset === null ? '✓ ' : '\u2003'}Customize…
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setAdvancedSettingsOpen(true)} className="gap-2">
                      <Settings className="h-4 w-4" />Advanced…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {/* Backup dropdown — separate from settings */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Backup & Restore">
                      <HardDrive className={`h-4 w-4 transition-colors duration-700 ${backupIndicator === 'unsaved' ? 'text-red-500' : backupIndicator === 'saved' ? 'text-green-500' : ''}`} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      disabled={backupStatus === 'saving' || backupStatus === 'encrypting'}
                      onClick={async () => {
                        try {
                          await saveBackup();
                          setBackupIndicator('saved');
                          toast({ title: 'Saved', description: 'Backup saved to Blossom.' });
                        } catch {
                          toast({ title: 'Save failed', description: 'Could not save to Blossom.', variant: 'destructive' });
                        }
                      }}
                      className="gap-2"
                    >
                      <CloudUpload className="h-4 w-4" />Save Now
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => {
                      // Just open the dialog — don't trigger a re-check that would
                      // flash the splash screen. The dialog shows existing checkpoints
                      // and has a "Search for more" button if the user wants to scan.
                      if ((backupStatus as string) === 'checking' || (backupStatus as string) === 'restoring') return;
                      setShowBackupConfirm(true);
                    }} className="gap-2"><HardDrive className="h-4 w-4" />Backup &amp; Restore</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setLocalBackupOpen(true)} className="gap-2"><HardDrive className="h-4 w-4" />Local File Backup</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {canLoadNotes && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Relays & Servers">
                        <Wifi className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={() => { setAdvancedSettingsOpen(true); setAdvancedSection('relays'); }} className="gap-2"><Wifi className="h-4 w-4" />Relays</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => { setAdvancedSettingsOpen(true); setAdvancedSection('blossom'); }} className="gap-2"><Server className="h-4 w-4" />Blossom Servers</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button onClick={openCompose} size="sm" className="bg-orange-500 hover:bg-orange-600 text-white font-medium gap-1 h-7 px-2 text-xs">
                  <PenSquare className="h-3 w-3" />
                  Post
                </Button>
                <DropdownMenu open={mobileAccountOpen} onOpenChange={setMobileAccountOpen}>
                  <DropdownMenuTrigger asChild>
                    <button className="p-0.5 rounded-full hover:bg-accent transition-colors">
                      <Avatar className="h-6 w-6">
                        <AvatarImage src={loggedInPicture} alt={loggedInName || 'Account'} />
                        <AvatarFallback className="text-[8px]">{loggedInName?.charAt(0) || '?'}</AvatarFallback>
                      </Avatar>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56 p-2">
                    <DropdownMenuItem onClick={() => setEditProfileOpen(true)} className="flex items-center gap-2 cursor-pointer p-2 rounded-md">
                      <UserPlus className="h-4 w-4" />
                      <span className="text-sm">Customize Profile</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setWalletSettingsOpen(true)} className="flex items-center gap-2 cursor-pointer p-2 rounded-md">
                      <Wallet className="h-4 w-4" />
                      <span className="text-sm">Connect Wallet</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setScanToZapOpen(true)} className="flex items-center gap-2 cursor-pointer p-2 rounded-md">
                      <ScanLine className="h-4 w-4" />
                      <span className="text-sm">Scan to Zap</span>
                    </DropdownMenuItem>
                    {/* Switch to another logged-in account (mobile-viewport menu — the
                        desktop header uses AccountSwitcher for this). */}
                    {otherUsers.length > 0 && <DropdownMenuSeparator />}
                    {otherUsers.map((acct) => {
                      const acctName = acct.metadata.name ?? genUserName(acct.pubkey);
                      return (
                        <DropdownMenuItem
                          key={acct.id}
                          onClick={() => switchToAccount(acct.id)}
                          className="flex items-center gap-2 cursor-pointer p-2 rounded-md"
                        >
                          <Avatar className="h-6 w-6">
                            <AvatarImage src={optimizeAvatarUrl(acct.metadata.picture)} alt={acctName} />
                            <AvatarFallback className="text-[8px]">{acctName.charAt(0)}</AvatarFallback>
                          </Avatar>
                          <span className="text-sm truncate flex-1">{acctName}</span>
                        </DropdownMenuItem>
                      );
                    })}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setAddAccountDialogOpen(true)} className="flex items-center gap-2 cursor-pointer p-2 rounded-md">
                      <UserPlus className="h-4 w-4" />
                      <span className="text-sm">Add Account</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={(e) => { e.preventDefault(); handleLogout(); }} className="flex items-center gap-2 cursor-pointer p-2 rounded-md">
                      <LogOut className="h-4 w-4" />
                      <span className="text-sm">Log out</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <Dialog open={addAccountDialogOpen} onOpenChange={setAddAccountDialogOpen}>
              <DialogContent className="max-w-[95vw] sm:max-w-lg max-h-[90dvh] overflow-y-auto" aria-describedby={undefined}>
                <DialogTitle className="sr-only">Add another account</DialogTitle>
                <WelcomePage onClose={() => setAddAccountDialogOpen(false)} />
              </DialogContent>
            </Dialog>
          </div>
        ) : (
        <div className="flex justify-between items-center mb-2">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <BrandLogo className="h-8 w-auto" />
              <h1 className="sr-only">corkboards.me</h1>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFeaturesModalOpen(true)}
                className="h-8 w-8 p-0 text-orange-500 hover:text-orange-600 font-bold rounded-full"
                title="Future features"
              >
                ?
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={toggleTheme}
                className="h-8 w-8 p-0"
                title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
              >
                {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 relative">
                    <Settings className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => setEmojiSetsOpen(true)} className="gap-2">
                    <Smile className="h-4 w-4" />
                    Emoji Sets
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="gap-2">
                      <Volume2 className="h-4 w-4" />Sound: {consolidateSound === 'solitaire' ? 'Solitaire' : consolidateSound === 'chimes' ? 'Chimes' : 'Off'}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {[
                        { val: 'solitaire', label: 'Solitaire' },
                        { val: 'chimes', label: 'Chimes' },
                        { val: 'off', label: 'Off' },
                      ].map(opt => (
                        <DropdownMenuItem key={opt.val} onClick={() => setConsolidateSound(opt.val)}>
                          {consolidateSound === opt.val ? '✓ ' : '\u2003'}{opt.label}
                        </DropdownMenuItem>
                      ))}
                      {consolidateSound !== 'off' && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => setSoundAccelerate(!soundAccelerate)}>
                            {soundAccelerate ? '✓ ' : '\u2003'}Accelerate
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="gap-2">
                      <SlidersHorizontal className="h-4 w-4" />Throughput: {activeThroughputPreset ? `${activeThroughputPreset}x` : 'Custom'}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {([1, 2, 3] as const).map(tier => (
                        <DropdownMenuItem key={tier} onClick={() => applyThroughputPreset(tier)}>
                          {activeThroughputPreset === tier ? '✓ ' : '\u2003'}{tier}x
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setCustomSettingsOpen(true)}>
                        {activeThroughputPreset === null ? '✓ ' : '\u2003'}Customize…
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setAdvancedSettingsOpen(true)} className="gap-2">
                    <Settings className="h-4 w-4" />Advanced…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* Backup dropdown — separate from settings */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Backup & Restore">
                    <HardDrive className={`h-4 w-4 transition-colors duration-700 ${backupIndicator === 'unsaved' ? 'text-red-500' : backupIndicator === 'saved' ? 'text-green-500' : ''}`} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    disabled={backupStatus === 'saving' || backupStatus === 'encrypting'}
                    onClick={async () => {
                      const ok = await saveBackup();
                      if (ok) {
                        setBackupIndicator('saved');
                        toast({ title: 'Saved', description: 'Backup saved to Blossom.' });
                      } else {
                        toast({ title: 'Save failed', description: 'Could not save to Blossom — check your server list in Advanced Settings.', variant: 'destructive' });
                      }
                    }}
                    className="gap-2"
                  >
                    <CloudUpload className="h-4 w-4" />Save Now
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => {
                      if ((backupStatus as string) === 'checking' || (backupStatus as string) === 'restoring') return;
                      setShowBackupConfirm(true);
                    }} className="gap-2">
                    <CloudUpload className="h-4 w-4" />
                    Backup &amp; Restore
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setLocalBackupOpen(true)} className="gap-2">
                    <HardDrive className="h-4 w-4" />
                    Local File Backup
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {canLoadNotes && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Relays & Servers">
                      <Wifi className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => { setAdvancedSettingsOpen(true); setAdvancedSection('relays'); }} className="gap-2"><Wifi className="h-4 w-4" />Relays</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => { setAdvancedSettingsOpen(true); setAdvancedSection('blossom'); }} className="gap-2"><Server className="h-4 w-4" />Blossom Servers</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <Button
              onClick={openCompose}
              size="sm"
              className="bg-orange-500 hover:bg-orange-600 text-white font-medium gap-1.5 text-xs"
              title="New Post"
            >
              <PenSquare className="h-3.5 w-3.5" />
              New Post
            </Button>
            <Separator orientation="vertical" className="h-8 mx-2" />
            <AccountSwitcher onAddAccountClick={() => setAddAccountDialogOpen(true)} onLogout={handleLogout} onEditProfile={() => setEditProfileOpen(true)} onConnectWallet={() => setWalletSettingsOpen(true)} />
            <Dialog open={addAccountDialogOpen} onOpenChange={setAddAccountDialogOpen}>
              <DialogContent className="max-w-[95vw] sm:max-w-lg max-h-[90dvh] overflow-y-auto" aria-describedby={undefined}>
                <DialogTitle className="sr-only">Add another account</DialogTitle>
                <WelcomePage onClose={() => setAddAccountDialogOpen(false)} />
              </DialogContent>
            </Dialog>
          </div>
        </div>
        )}

        {/* Delete corkboard confirmation dialog */}
        <AlertDialog open={!!deleteFeedId} onOpenChange={(open) => { if (!open) setDeleteFeedId(null); }}>
          <AlertDialogContent className="max-w-sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Remove corkboard?</AlertDialogTitle>
              <AlertDialogDescription>
                {deleteFeedId && (() => {
                  const feed = customFeeds.find(f => f.id === deleteFeedId);
                  return feed ? `"${feed.title}" will be removed. This cannot be undone.` : 'This corkboard will be removed.';
                })()}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  if (deleteFeedId) {
                    setCustomFeeds(customFeeds.filter(f => f.id !== deleteFeedId));
                    setActiveTab('me');
                    setDeleteFeedId(null);
                    setBackupIndicator('unsaved');
                  }
                }}
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Public bookmarks confirmation dialog */}
        <AlertDialog open={showPublicBookmarksConfirm} onOpenChange={setShowPublicBookmarksConfirm}>
          <AlertDialogContent className="max-w-sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Enable public bookmarks?</AlertDialogTitle>
              <AlertDialogDescription>
                This will allow your bookmarks to be seen in other Nostr clients, but they will also be publicly visible to anyone — including relay operators and other users.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => { setPublicBookmarks(true); setTimeout(republishBookmarks, 500); setShowPublicBookmarksConfirm(false); }}>
                Enable
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Restore confirmation dialog */}
        <Dialog open={showRestoreConfirm} onOpenChange={setShowRestoreConfirm}>
          <DialogContent className="max-w-xs p-4">
            <div className="text-center space-y-3">
              <p className="text-sm font-medium">Restore from Nostr?</p>
              <p className="text-xs text-destructive">
                Any changes made in this browser since your last backup will be lost.
              </p>
              {remoteBackup && (
                <div className="text-xs bg-muted/50 rounded p-2 space-y-1">
                  <p><span className="font-medium">{remoteBackup.stats?.corkboards ?? 0}</span> corkboards</p>
                  <p><span className="font-medium">{remoteBackup.stats?.savedForLater ?? 0}</span> saved for later</p>
                  <p><span className="font-medium">{remoteBackup.stats?.dismissed ?? 0}</span> dismissed</p>
                </div>
              )}
              <div className="flex gap-2 justify-center">
                <Button variant="outline" size="sm" onClick={() => setShowRestoreConfirm(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setShowRestoreConfirm(false);
                    loadRemoteBackup();
                  }}
                >
                  Restore
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Backup &amp; Restore — autosave history + restore */}
        <Dialog open={showBackupConfirm} onOpenChange={setShowBackupConfirm}>
          <DialogContent className="sm:max-w-[450px] max-h-[80dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><CloudUpload className="h-4 w-4" />Backup &amp; Restore</DialogTitle>
              <DialogDescription className="sr-only">View autosave history and restore previous states</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Changes are automatically saved to Blossom. You can restore any of the last 5 autosave states below.
                {(backupStatus as string) === 'checking' && (
                  <span className="inline-flex items-center gap-1 ml-1 text-orange-500">
                    <Loader2 className="h-3 w-3 animate-spin inline" /> Checking for updates...
                  </span>
                )}
              </p>

              {/* Current state */}
              <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/20 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-medium text-green-700 dark:text-green-400 mb-1">Current State</p>
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <p>{customFeeds.length} corkboards{customFeeds.length > 0 ? `: ${customFeeds.map(f => f.title).filter(Boolean).join(', ')}` : ''}</p>
                      <p>{new Set([...collapsedIds, ...bookmarkIds]).size} saved, {dismissedCount} dismissed</p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-xs shrink-0"
                    disabled={backupStatus === 'saving' || backupStatus === 'encrypting'}
                    onClick={async () => {
                      try {
                        await saveBackup();
                        toast({ title: 'State saved', description: 'Current state saved as a checkpoint.' });
                      } catch {
                        toast({ title: 'Save failed', description: 'Could not save current state.', variant: 'destructive' });
                      }
                    }}
                  >
                    {backupStatus === 'saving' || backupStatus === 'encrypting' ? (
                      <><Loader2 className="h-3 w-3 animate-spin mr-1" />Saving...</>
                    ) : (
                      <>Save</>
                    )}
                  </Button>
                </div>
              </div>

              {/* Autosave history */}
              {checkpoints.length > 0 && (
                <div className="space-y-2 border-t pt-3">
                  <p className="text-xs font-medium text-muted-foreground">Autosave History</p>
                  {checkpoints.map((cp, i) => {
                    const isLatest = i === 0;
                    return (
                    <div key={`${cp.eventId}-${i}`} className="rounded-lg border p-3 space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-xs">{new Date(cp.timestamp * 1000).toLocaleString()}</span>
                          {isLatest && <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300">latest</span>}
                        </div>
                      </div>
                      {cp.stats && (
                        <div className="text-xs text-muted-foreground space-y-0.5">
                          <p>{cp.stats.corkboards} corkboards{cp.corkboardNames?.length ? `: ${cp.corkboardNames.join(', ')}` : ''}</p>
                          <p>{cp.stats.savedForLater} saved, {cp.stats.dismissed} dismissed</p>
                        </div>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-xs mt-1"
                        onClick={() => { setShowBackupConfirm(false); setCheckpointToRestoreIdx(i); }}
                      >
                        Restore
                      </Button>
                    </div>
                    );
                  })}
                </div>
              )}

              {/* Find older states button */}
              <div className="border-t pt-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs gap-2"
                  onClick={scanOlderStates}
                  disabled={isScanning || (backupStatus as string) === 'checking'}
                >
                  {isScanning ? (
                    <><Loader2 className="h-3 w-3 animate-spin" />Scanning relays...</>
                  ) : (
                    <>Search for more</>
                  )}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Local File Backup modal */}
        <Dialog open={localBackupOpen} onOpenChange={setLocalBackupOpen}>
          <DialogContent className="max-w-xs p-4">
            <div className="space-y-3">
              <p className="text-sm font-medium">Local File Backup</p>
              <p className="text-xs text-muted-foreground">
                Download or upload a JSON file containing all your corkboards.me settings.
                Identical to the remote backup — includes everything.
              </p>
              <div className="flex flex-col gap-2">
                <Button size="sm" variant="outline" className="gap-2 justify-start" onClick={async () => { await downloadSettingsBackup(); setLocalBackupOpen(false); }}>
                  <Download className="h-4 w-4" />Download File
                </Button>
                <Button size="sm" variant="outline" className="gap-2 justify-start" onClick={() => { settingsFileRef.current?.click(); setLocalBackupOpen(false); }}>
                  <Upload className="h-4 w-4" />Upload File
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Local settings backup download prompt */}
        <BackupDownloadPrompt open={showDownloadPrompt} onOpenChange={setShowDownloadPrompt} />

        {/* Logout save-failed warning */}
        <AlertDialog open={showLogoutSaveWarning} onOpenChange={setShowLogoutSaveWarning}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Could not save to Blossom</AlertDialogTitle>
              <AlertDialogDescription>
                Your changes could not be saved before logout. You can retry, download a local backup, or log out anyway and lose unsaved changes.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={async () => {
                setShowLogoutSaveWarning(false);
                await handleLogout();
              }}>
                Retry Backup to Blossom
              </AlertDialogAction>
              <AlertDialogAction onClick={() => { downloadBackupAsFile(); doLogout(); }}>
                Download &amp; Logout
              </AlertDialogAction>
              <AlertDialogAction onClick={() => doLogout()}>
                Logout Anyway
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Tab navigation strip (mobile pills / desktop ScrollArea tabs + new-corkboard dialog) */}
        {tabBarCollapsed ? (
          <div className="relative flex items-center justify-end h-6">
            <button
              onClick={() => setTabBarCollapsed(false)}
              className="w-0 h-0 border-l-[24px] border-l-transparent border-b-[24px] border-b-green-600/70 hover:border-b-green-500/70 transition-colors"
              title="Show tab bar"
            />
          </div>
        ) : (
          <div className={`relative -mx-4 px-2 sm:px-8 py-0.5 sm:py-1.5 bg-gradient-to-r from-gray-100/95 to-gray-200/95 dark:from-gray-900/95 dark:to-gray-800/95 backdrop-blur-sm border-b border-white/20 dark:border-white/10 min-h-[24px] sm:min-h-[28px] ${stickyTabBar ? 'sticky top-0 z-30 shadow-sm' : ''}`}>
            <TabBar
              activeTab={optimisticTab}
              setActiveTab={setActiveTab}
              isPending={isTabPending}
              userPubkey={user?.pubkey}
              collapsedCount={new Set([...collapsedIds, ...bookmarkIds]).size}
              newNotificationCount={newNotificationCount}
              customFeeds={customFeeds}
              setCustomFeeds={setCustomFeeds}
              browseRelays={browseRelays}
              setBrowseRelays={setBrowseRelays}
              rssFeeds={rssFeeds}
              setRssFeeds={setRssFeeds}
              availableFollows={availableFollows}
              followsData={followsData}
              allFollowsData={allFollowsData}
              contacts={contacts}
              isLoadingFollows={isLoadingFollows}
              followsOffset={followsOffset}
              hasMoreFollows={hasMoreFollows}
              isLoadingMoreFollows={isLoadingMoreFollows}
              onLoadMoreFollows={handleLoadMoreFollows}
              showAddFriendDialog={showAddFriendDialog}
              setShowAddFriendDialog={setShowAddFriendDialog}
              editingFeedId={editingFeedId}
              setEditingFeedId={setEditingFeedId}
              feedTitle={feedTitle}
              setFeedTitle={setFeedTitle}
              feedPubkeys={feedPubkeys}
              setFeedPubkeys={setFeedPubkeys}
              feedRelays={feedRelays}
              setFeedRelays={setFeedRelays}
              feedRssUrls={feedRssUrls}
              setFeedRssUrls={setFeedRssUrls}
              feedHashtags={feedHashtags}
              setFeedHashtags={setFeedHashtags}
              newFriendInput={newFriendInput}
              setNewFriendInput={setNewFriendInput}
              addFeedSource={addFeedSource}
              parseFeedSource={parseFeedSource}
              onCreateOrUpdateFeed={handleCreateOrUpdateFeed}
              showToast={({ title, variant }) => toast({ title, variant })}
              followSets={followSets}
              isLoadingFollowSets={isLoadingFollowSets}
              isOnboarding={isOnboarding}
              onEditFeed={(feedId) => {
                const feed = customFeeds.find(f => f.id === feedId);
                if (!feed) return;
                setEditingFeedId(feedId);
                setFeedTitle(feed.title);
                setFeedPubkeys(new Set(feed.pubkeys));
                setFeedRelays(feed.relays.join(', '));
                setFeedRssUrls(new Set(feed.rssUrls || []));
                setFeedHashtags(new Set(feed.hashtags || []));
                setShowAddFriendDialog(true);
              }}
              onDeleteFeed={(feedId) => setDeleteFeedId(feedId)}
              onRefreshTab={loadNewerAndRetry}
            />
            <div className="absolute top-0 left-0 flex">
              <button
                onClick={() => setStickyTabBar(!stickyTabBar)}
                className={`w-0 h-0 border-r-[24px] border-r-transparent border-t-[24px] transition-colors ${
                  stickyTabBar
                    ? 'border-t-green-500 hover:border-t-green-400'
                    : 'border-t-green-600/70 hover:border-t-green-500/70'
                }`}
                title={stickyTabBar ? "Unstick tab bar" : "Stick tab bar"}
              />
            </div>
            <div className="absolute top-0 right-0 flex">
              <button
                onClick={() => setTabBarCollapsed(true)}
                className="w-0 h-0 border-l-[24px] border-l-transparent border-t-[24px] border-t-red-600/70 hover:border-t-red-500/70 transition-colors"
                title="Hide tab bar"
              />
            </div>
          </div>
        )}

        {/* Wrap feed content in a keyed ErrorBoundary — resets on every tab change,
            preventing concurrent-rendering portal errors (removeChild / No QueryClient)
            from propagating to the root ErrorBoundary and crashing the entire app. */}
        <ErrorBoundary key={activeTab} fallback={
          <div className="mt-4 p-4 text-sm text-muted-foreground text-center rounded-lg border">
            This tab encountered a display error. Switch to another tab and back to refresh.
          </div>
        }>
        {/* Dim content during tab transition to mask the brief flash of stale content */}
        <div className={isTabPending ? 'opacity-50 pointer-events-none transition-opacity duration-150' : undefined}>

        {/* Per-tab info / filter card */}
        <div className="mt-4">
          {isNotificationsTab ? (
            <ErrorBoundary>
              <NotificationsCorkboard
                onViewThread={openThread}
                columnCount={columnCount}
                onBlankSpaceCount={setNotifBlankCount}
                onStatsUpdate={setNotifStats}
                onLoadMoreReady={handleNotifLoadMoreReady}
              />
            </ErrorBoundary>
          ) : activeTab === 'me' ? (
            <ProfileCard
              pubkey={user.pubkey}
              showPlaceholders
              stats={{
                follows: contacts?.length,
                noteKinds: userNoteKindStats
              }}
              hashtags={filteredHashtags}
              className="bg-gradient-to-br from-purple-50 to-pink-50 dark:from-card dark:to-card border-purple-200 dark:border-border"
              hoursLoaded={hoursLoaded}
              multiplier={feedLimitMultiplier}
              showPinned={showPinned}
              onToggleShowPinned={() => setShowPinned(!showPinned)}
              showUnpinned={showUnpinned}
              onToggleShowUnpinned={() => setShowUnpinned(!showUnpinned)}
              onFilterByKind={handleFilterByKind}
              onFilterByHashtag={handleFilterByHashtag}
              filterMode={filterMode}
              onToggleFilterMode={() => setFilterMode(filterMode === 'any' ? 'strict' : 'any')}
              kindFilters={kindFilters}
              hashtagFilters={hashtagFilters}
              onClearFilters={() => { setKindFilters(new Set()); setHashtagFilters(new Set()); resetContentFilters(); }}
              contentFilterConfig={contentFilterConfig}
              onContentFilterChange={handleContentFilterChange}
              hasActiveContentFilters={hasActiveContentFilters}
              dismissedCount={dismissedCount}
              visibleNotesCount={notes.length}
              onEditProfile={() => setEditProfileOpen(true)}
            />
          ) : isFriendTab ? (
            <>
              <ProfileCard
                pubkey={activeTab}
                stats={{
                  noteKinds: friendNoteKindStats
                }}
                hashtags={filteredHashtags}
                className="bg-gradient-to-br from-purple-50 to-pink-50 dark:from-card dark:to-card border-purple-200 dark:border-border"
                hoursLoaded={hoursLoaded}
                multiplier={feedLimitMultiplier}
                onFilterByKind={handleFilterByKind}
                onFilterByHashtag={handleFilterByHashtag}
                filterMode={filterMode}
                onToggleFilterMode={() => setFilterMode(filterMode === 'any' ? 'strict' : 'any')}
                kindFilters={kindFilters}
                hashtagFilters={hashtagFilters}
                onClearFilters={() => { setKindFilters(new Set()); setHashtagFilters(new Set()); resetContentFilters(); }}
                contentFilterConfig={contentFilterConfig}
                onContentFilterChange={handleContentFilterChange}
                hasActiveContentFilters={hasActiveContentFilters}
              />
              <div className="flex items-center gap-2 mt-2">
{user?.pubkey && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isLoadingContacts}
                    className={`text-xs gap-1 ${contacts?.includes(activeTab) ? 'text-green-600' : 'text-purple-600 hover:text-purple-700'}`}
                    onClick={() => {
                      if (!user?.pubkey) return;
                      if (contacts?.includes(activeTab)) {
                        void safeUpdateContacts({ remove: activeTab }, { title: 'Unfollowed', description: 'Contact list updated' });
                      } else {
                        void safeUpdateContacts({ add: activeTab }, { title: 'Followed', description: 'Contact list updated' });
                      }
                    }}
                  >
                    {contacts?.includes(activeTab) ? <UserCheck className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />}
                    {contacts?.includes(activeTab) ? 'Following' : 'Follow'}
                  </Button>
                )}
              </div>
            </>
          ) : isOnboarding && isDiscoverTab ? (
            null
          ) : (
            <FeedInfoCard
              key={isRelayTab ? `relay:${activeTab}` : isCustomFeedTab ? 'custom' : isAllFollowsTab ? 'follows' : isSavedTab ? 'saved' : isRssTab ? 'rss' : isDiscoverTab ? 'discover' : 'default'}
              activeTab={activeTab}
              isInfoCollapsed={isSavedTab ? false : isInfoCollapsed}
              onToggleInfoCollapsed={() => setIsInfoCollapsed(!isInfoCollapsed)}
              isFiltersCollapsed={isFiltersCollapsed}
              onToggleFiltersCollapsed={() => setIsFiltersCollapsed(!isFiltersCollapsed)}
              isRelayTab={isRelayTab}
              isCustomFeedTab={isCustomFeedTab}
              isAllFollowsTab={isAllFollowsTab}
              isRssTab={isRssTab}
              isDiscoverTab={isDiscoverTab}
              isSavedTab={isSavedTab}
              isFriendTab={isFriendTab}
              activeCustomFeed={activeCustomFeed}
              activeRssFeed={activeRssFeed}
              contacts={contacts}
              stats={isDiscoverTab ? discoverStats : activeTabStats}
              notesCount={notes.length}
              totalLoaded={deduplicatedNotes.length}
              dismissedCount={dismissedCount}
              hasFilteredNotes={hasFilteredNotes}
              batchProgress={batchProgress}
              isLoadingAllFollows={isLoadingAllFollows}
              isLoadingDiscover={isLoadingDiscover}
              isLoadingRss={isLoadingRss}
              isLoadingMore={isLoadingMore}
              isLoadingCustomFeed={isLoadingCustomFeedNotes && isCustomFeedTab}
              hasMore={isCustomFeedTab ? customFeedHasMore : (hasMore[activeTab] !== false)}
              hasActiveFilters={hasActiveFilters}
              hasActiveContentFilters={hasActiveContentFilters}
              showOwnNotes={showOwnNotes}
              onToggleOwnNotes={() => setShowOwnNotes(!showOwnNotes)}
              kindFilters={kindFilters}
              hashtagFilters={hashtagFilters}
              filteredHashtags={filteredHashtags}
              onFilterByKind={handleFilterByKind}
              filterMode={filterMode}
              onToggleFilterMode={() => setFilterMode(filterMode === 'any' ? 'strict' : 'any')}
              onFilterByHashtag={handleFilterByHashtag}
              onClearFilters={() => { setKindFilters(new Set()); setHashtagFilters(new Set()); resetContentFilters(); }}
              contentFilterConfig={contentFilterConfig}
              onContentFilterChange={handleContentFilterChange}
              onLoadMore={handleLoadMore}
              onRefreshDiscover={refreshDiscover}
              onRemoveRelay={(url) => { setBrowseRelays(browseRelays.filter(r => r !== url)); setActiveTab('me'); }}
              onRemoveRss={(url) => { setRssFeeds(rssFeeds.filter(f => f !== url)); setActiveTab('me'); toast({ title: 'RSS feed removed' }); }}
              onEditFeed={(feedId) => {
                const feed = customFeeds.find(f => f.id === feedId);
                if (!feed) return;
                setEditingFeedId(feedId);
                setFeedTitle(feed.title);
                setFeedPubkeys(new Set(feed.pubkeys));
                setFeedRelays(feed.relays.join(', '));
                setFeedRssUrls(new Set(feed.rssUrls || []));
                setFeedHashtags(new Set(feed.hashtags || []));
                setShowAddFriendDialog(true);
              }}
              onDeleteFeed={(feedId) => setDeleteFeedId(feedId)}
              isFollowed={isCustomFeedTab && activeCustomFeed?.pubkeys?.length === 1 ? contacts?.includes(activeCustomFeed.pubkeys[0]) : undefined}
              onToggleFollow={isCustomFeedTab && activeCustomFeed?.pubkeys?.length === 1 && user?.pubkey ? () => {
                if (!user?.pubkey) return;
                const pk = activeCustomFeed?.pubkeys?.[0];
                if (!pk) return;
                if (contacts?.includes(pk)) {
                  void safeUpdateContacts({ remove: pk }, { title: 'Unfollowed', description: 'Contact list updated' });
                } else {
                  void safeUpdateContacts({ add: pk }, { title: 'Followed', description: 'Contact list updated' });
                }
              } : undefined}
              onThreadClick={openThread}
              onOpenThread={openThread}
              columnCount={columnCount}
            />
          )}
        </div>

        {/* Onboard search widget — shown during onboard procedure on discover tab */}
        {isOnboarding && isDiscoverTab && <OnboardSearchWidget contactCount={contacts?.length ?? 0} followTarget={onboardFollowTarget} onSkip={() => { setOnboardingSkipped(true); markOnboarded(); setActiveTab('me'); autoSaveBackup().then((result) => { if (result === 'saved') { setBackupIndicator('saved'); } else if (result !== 'skipped') { toast({ title: 'Backup not saved', description: 'Onboarding preference could not be saved to cloud. It will retry automatically.', variant: 'destructive' }); } }).catch(() => {}); }} />}



        {/* Masonry feed columns + load older/newer/consolidate buttons */}
        {!isNotificationsTab && <FeedGrid
          columns={columns}
          columnCount={columnCount}
          noteClassifications={noteClassifications}
          parentNotes={parentNotes}
          pinnedNoteIds={pinnedIds}
          activeTab={activeTab}
          freshNoteIds={freshNoteIds}
          isSavedTab={isSavedTab}
          isLoading={isLoading}
          pinnedNotesStatus={pinnedNotesStatus}
          showOwnNotes={showOwnNotes}
          batchProgress={batchProgress}
          authorCount={activeTab === 'me' ? 1 : (isCustomFeedTab ? activeCustomFeed?.pubkeys?.length : contacts?.length)}
          hasMore={isSavedTab ? false : hasMore[activeTab] !== false}
          isLoadingMore={isLoadingMore}
          hoursLoaded={hoursLoaded}
          multiplier={feedLimitMultiplier}
          isLookingFurther={isCustomFeedTab ? isLookingFurtherCustomFeed : false}
          isLoadingNewer={isLoadingNewer}
          blankSpaceCount={blankSpaceCount}
          revealMoreTick={revealMoreTick}
          onLoadNewer={isSavedTab ? noopCallback : loadNewerAndRetry}
          onLoadMore={isSavedTab ? noopCallback : handleLoadMore}
          onConsolidate={consolidate}
          onThreadClick={openThread}
          onComment={openThreadAndReply}
          onOpenThread={openThread}
          activeHashtags={isCustomFeedTab ? activeHashtags : undefined}
          onOpenEmojiSets={handleOpenEmojiSets}
          onPinClick={handlePinNote}
          onZapClick={handleZapClick}
          onRepost={handleRepostClick}
          onPinToBoard={handlePinToBoard}
          onDeleteNote={handleDeleteNote}
          onReactionPublished={handleReactionPublished}
          engagementByTarget={mergedEngagementByTarget}
          stubNoteIds={stubNoteIds}
          onDismissThread={handleDismissThread}
          userPubkey={user?.pubkey}
          loadAllMedia={loadAllMedia}
          mediaFilterActive={loadAllMedia && kindFilters.size > 0 && (!kindFilters.has('images') || !kindFilters.has('videos'))}
          discoverMode={isDiscoverTab}
          allDismissed={allDismissed}
          findingUndismissed={findingUndismissed}
          dismissedCount={deduplicatedNotes.length}
          onLoadMoreDiscover={loadMoreDiscover}
          hasMoreDiscover={hasMoreDiscover}
          totalDiscoverCount={totalDiscoverCount}
          isOnboarding={isOnboarding && isDiscoverTab}
          onFindMoreForMe={isOnboarding && isDiscoverTab ? fetchMoreOnboardActivity : undefined}
          isFindingMore={isLoadingMoreOnboard}
        />}

        </div>{/* end isTabPending wrapper */}
        </ErrorBoundary>

        {/* Status Bar with inline buttons */}
        {/* Compute stats based on active tab — notifications have their own data source */}
        <StatusBar
          onLoadNewer={isSavedTab ? noopCallback : loadNewerAndRetry}
          onLoadMoreByCount={isSavedTab ? noopCallback : handleLoadMoreByCount}
          onConsolidate={consolidate}
          onSave={() => { setShowBackupConfirm(true); checkRemoteBackup(true); }}
          onRestore={() => remoteBackup ? setShowRestoreConfirm(true) : checkRemoteBackup(true)}
          isLoading={isLoadingMore || isLoadingNewer}
          loadingMessage={loadingMessage}
          blankSpaceCount={blankSpaceCount}
          multiplier={feedLimitMultiplier}
          indexedDbStats={isNotificationsTab ? notifStats : feedStats}
          backupStatus={backupStatus}
          _hasChanges={hasChanges}
          isSavedTab={isSavedTab}
          isDiscoverTab={isDiscoverTab}
           newestTimestamp={lastFetchTime}
          autofetch={autofetch}
          autofetchIntervalSecs={autofetchIntervalSecs}
          lastAutofetchTime={lastAutofetchTime}
          onToggleAutofetch={() => setAutofetch(prev => !prev)}
          autoConsolidate={autoConsolidate}
          onToggleAutoConsolidate={() => setAutoConsolidate(prev => !prev)}
          autoScrollTop={autoScrollTop}
          onToggleAutoScrollTop={() => setAutoScrollTop(prev => !prev)}
          loadAllMedia={loadAllMedia}
          onToggleLoadAllMedia={() => setLoadAllMedia(prev => !prev)}
          scrolledFromTop={scrolledFromTop}
          columnCount={optimisticColumnCount}
          onColumnCountChange={handleColumnCountChange}
          isColumnPending={isColumnPending}
          isNotificationsTab={isNotificationsTab}
          onLoadMoreNotifications={notifLoadMoreRef.current || undefined}
          hasMoreNotifications={notifHasMore}
          onLoadNewerNotifications={notifLoadNewerRef.current || undefined}
          newestNotificationTimestamp={notifNewestTimestamp}
        />

        {/* Auto-restore countdown banner */}
        {autoRestoreTarget && autoRestoreCountdown !== null && autoRestoreCountdown > 0 && (
          <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[100] bg-orange-500 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-3 text-sm animate-in fade-in slide-in-from-top-2">
            <span>{autoRestoreTarget.reason} — loading in {autoRestoreCountdown}s</span>
            <button
              className="text-white/80 hover:text-white font-medium underline"
              onClick={() => setAutoRestoreTarget(null)}
            >Cancel</button>
          </div>
        )}

        {/* Toast Messages */}
        <ToastBar messages={feedToastMessages} />

        {/* Future Features Modal */}
        <Dialog open={featuresModalOpen} onOpenChange={setFeaturesModalOpen}>
          <DialogContent className="max-w-[95vw] sm:max-w-md" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle className="text-xl font-semibold text-center text-orange-500">
                Future Features
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-4">
              <p className="text-sm text-muted-foreground">
                Here are some features we're planning for corkboards.me:
              </p>
              <ul className="space-y-2 text-sm list-disc list-inside">
                <li className="text-orange-500 font-medium">Much more coming soon!</li>
              </ul>
              <p className="text-xs text-muted-foreground italic mt-4">
                Stay tuned for updates!
              </p>
            </div>
          </DialogContent>
        </Dialog>

        {/* Thread Panel — statically imported, no lazy/Suspense needed */}
        <ThreadPanel
          eventId={threadEventId}
          isOpen={isThreadModalOpen}
          onClose={() => {
            setIsThreadModalOpen(false);
            setThreadEventId(null);
            autoReplyNoteRef.current = null;
            try { sessionStorage.removeItem(OPEN_THREAD_KEY); } catch { /* sessionStorage unavailable */ }
          }}
          onQuote={openQuote}
          onRepost={openRepost}
          onZap={(event) => setZapTargetNote(event)}
          onPinToBoard={handlePinToBoard}
          onReactionPublished={handleReactionPublished}
          onReplyPublished={handleComposePublished}
          autoReplyTo={autoReplyNoteRef.current}
          onOpenEmojiSets={handleOpenEmojiSets}
          onNavigateThread={(id) => setThreadEventId(id)}
        />

        {/* Compose Dialog — only mount when open to avoid lazy-chunk context race on first render */}
        {(isComposeOpen || !!composeRepostEvent) && (
          <ErrorBoundary fallback={
            <Dialog open onOpenChange={(open) => { if (!open) closeCompose(); }}>
              <DialogContent className="max-w-sm">
                <DialogHeader>
                  <DialogTitle>Couldn't open compose</DialogTitle>
                  <DialogDescription>Failed to load the compose dialog. Check your connection and try again.</DialogDescription>
                </DialogHeader>
                <div className="flex justify-end gap-2 mt-2">
                  <Button variant="outline" onClick={closeCompose}>Cancel</Button>
                  <Button onClick={() => { closeCompose(); setTimeout(openCompose, 50); }}>Retry</Button>
                </div>
              </DialogContent>
            </Dialog>
          }>
            <Suspense fallback={null}>
              <ComposeDialog
                isOpen={isComposeOpen}
                onClose={closeCompose}
                replyTo={composeReplyTo || undefined}
                quotedEvent={composeQuotedEvent || undefined}
                repostEvent={composeRepostEvent || undefined}
                onPublished={handleComposePublished}
                onRepostWithComment={handleRepostWithComment}
                onOpenEmojiSets={handleOpenEmojiSets}
              />
            </Suspense>
          </ErrorBoundary>
        )}

        {/* Pin to Board Dialog — always mounted, controlled open for clean mobile unmount */}
        <PinToBoardDialog
          note={pinToBoardNote}
          open={!!pinToBoardNote}
          onClose={() => setPinToBoardNote(null)}
          onPin={() => pinToBoardNote && executePinToBoard(pinToBoardNote)}
          onPinWithComment={() => pinToBoardNote && executePinToBoardWithComment(pinToBoardNote)}
          isAlreadyPinned={pinToBoardNote ? pinnedIds.includes(pinToBoardNote.id) : false}
        />

        {/* Zap Dialog */}
        <ZapDialog
          note={zapTargetNote}
          open={!!zapTargetNote}
          onOpenChange={(open) => { if (!open) setZapTargetNote(null); }}
          onOpenWalletSettings={() => setWalletSettingsOpen(true)}
        />

        {/* Scan a Lightning QR code and pay it with the connected wallet.
            Standalone: unlike ZapDialog this isn't tied to a note or author,
            so it's a plain payment rather than a NIP-57 zap. */}
        {/* Mounted only while open so the lazy chunk (jsQR scanner) loads on
            first use rather than at startup. */}
        {scanToZapOpen && (
          <Suspense fallback={null}>
            <ScanToZapDialog
              open={scanToZapOpen}
              onOpenChange={setScanToZapOpen}
              onOpenWalletSettings={() => setWalletSettingsOpen(true)}
            />
          </Suspense>
        )}

        {/* Customize Profile Dialog */}
        <Dialog open={editProfileOpen} onOpenChange={setEditProfileOpen}>
          <DialogContent className="sm:max-w-[520px] max-h-[85dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Customize Profile</DialogTitle>
              <DialogDescription className="sr-only">Edit your Nostr profile name, picture, and bio</DialogDescription>
            </DialogHeader>
            <EditProfileForm onSaved={() => setEditProfileOpen(false)} />
          </DialogContent>
        </Dialog>

        {/* Throughput Settings Dialog */}
        <Dialog open={customSettingsOpen} onOpenChange={setCustomSettingsOpen}>
          <DialogContent className="sm:max-w-[420px]">
            <DialogHeader>
              <DialogTitle>Throughput Settings</DialogTitle>
              <DialogDescription className="sr-only">Fine-tune feed speed and bandwidth usage</DialogDescription>
            </DialogHeader>
            <ThroughputSettings
              multiplier={feedLimitMultiplier}
              onMultiplierChange={setFeedLimitMultiplier}
              autofetchIntervalSecs={autofetchIntervalSecs}
              onAutofetchIntervalChange={setAutofetchIntervalSecs}
              avatarSizeLimit={avatarSizeLimit}
              onAvatarSizeLimitChange={setAvatarSizeLimit}
              imageSizeLimit={imageSizeLimit}
              onImageSizeLimitChange={setImageSizeLimit}
            />
          </DialogContent>
        </Dialog>

        {/* Wallet Settings Dialog */}
        <Dialog open={walletSettingsOpen} onOpenChange={setWalletSettingsOpen}>
          <DialogContent className="sm:max-w-[420px]">
            <DialogHeader>
              <DialogTitle>Wallet Settings</DialogTitle>
              <DialogDescription className="sr-only">Configure Nostr Wallet Connect for zap payments</DialogDescription>
            </DialogHeader>
            <WalletSettings />
          </DialogContent>
        </Dialog>

        {/* Profile Cache Settings Dialog */}
        <Dialog open={profileCacheSettingsOpen} onOpenChange={setProfileCacheSettingsOpen}>
          <DialogContent className="sm:max-w-[600px] max-h-[80dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Profile Cache Settings</DialogTitle>
              <DialogDescription className="sr-only">Manage locally cached Nostr profile data</DialogDescription>
            </DialogHeader>
            <ProfileCacheSettings />
          </DialogContent>
        </Dialog>

        {/* Advanced Settings Dialog */}
        <Dialog open={advancedSettingsOpen} onOpenChange={(open) => { setAdvancedSettingsOpen(open); if (!open) setAdvancedSection('main'); }}>
          <DialogContent className="sm:max-w-[420px] max-h-[85dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Advanced</DialogTitle>
              <DialogDescription className="sr-only">Advanced settings and account management</DialogDescription>
            </DialogHeader>
            <Suspense fallback={<div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>}>
            <AdvancedSettings
              dismissedCount={dismissedCount}
              onClearDismissed={() => { clearDismissed(); setAdvancedSettingsOpen(false); }}
              onRestoreOwnDismissed={user?.pubkey ? () => { restoreOwnDismissed(); setAdvancedSettingsOpen(false); } : undefined}
              onOpenProfileCache={() => { setAdvancedSettingsOpen(false); setProfileCacheSettingsOpen(true); }}
              publishClientTag={appConfig.publishClientTag === true}
              onToggleClientTag={() => updateConfig(c => ({ ...c, publishClientTag: !(c.publishClientTag === true) }))}
              publicBookmarks={publicBookmarks}
              onTogglePublicBookmarks={() => { if (publicBookmarks) { setPublicBookmarks(false); setTimeout(republishBookmarks, 500); } else { setPublicBookmarks(true); setTimeout(republishBookmarks, 500); } }}
              onDeleteAccount={() => { setAdvancedSettingsOpen(false); setShowVanishConfirm(true); }}
              initialSection={advancedSection}
              isOnboarding={isOnboarding}
              onResetOnboarding={() => { setOnboardFollowTarget((contacts?.length ?? 0) + 10); setOnboardingSkipped(false); if (user?.pubkey) clearOnboarded(user.pubkey); setHasOnboardedFlag(false); setAdvancedSettingsOpen(false); setActiveTab('discover'); }}
              collapseReactions={collapseReactions}
              onToggleCollapseReactions={() => setCollapseReactions(!collapseReactions)}
              renderMarkdown={renderMarkdown}
              onToggleRenderMarkdown={() => setRenderMarkdown(!renderMarkdown)}
            />
            </Suspense>
          </DialogContent>
        </Dialog>

        {/* Emoji Sets Dialog */}
        <Dialog open={emojiSetsOpen} onOpenChange={setEmojiSetsOpen}>
          <DialogContent className="sm:max-w-[520px] max-h-[85dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Emoji Sets</DialogTitle>
              <DialogDescription className="sr-only">Manage custom emoji sets for reactions</DialogDescription>
            </DialogHeader>
            <Suspense fallback={<div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>}>
              <EmojiSetEditor />
            </Suspense>
          </DialogContent>
        </Dialog>

        {/* Delete account (vanish) confirmation — two-step */}
        <Dialog open={showVanishConfirm} onOpenChange={(open) => { setShowVanishConfirm(open); if (!open) setVanishStep(1); }}>
          <DialogContent className="sm:max-w-[400px]">
            <DialogHeader>
              <DialogTitle className="text-red-500 flex items-center gap-2"><Trash2 className="h-4 w-4" />Delete Account</DialogTitle>
              <DialogDescription className="sr-only">Permanently delete your Nostr account and publish deletion requests</DialogDescription>
            </DialogHeader>
            {vanishStep === 1 ? (
              <>
                <div className="space-y-3 text-sm">
                  <p>This will publish deletion requests to Nostr relays for your:</p>
                  <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                    <li>Profile metadata (kind 0)</li>
                    <li>Contact/follow list (kind 3)</li>
                    <li>Relay list (kind 10002)</li>
                    <li>Backup data (kind 30078)</li>
                    <li>Corkboard sync (kind 35571)</li>
                    <li>Dismissed notes sync (kind 35572)</li>
                  </ul>
                  <p className="text-muted-foreground text-xs">
                    Relays that honor NIP-09 deletion requests will remove this data. Your secret key still works —
                    you can always create a new profile with it. All local data will be wiped.
                  </p>
                  <p className="text-red-500 font-medium text-xs">This cannot be undone.</p>
                </div>
                <div className="flex gap-2 justify-end mt-2">
                  <Button variant="outline" size="sm" onClick={() => setShowVanishConfirm(false)}>Cancel</Button>
                  <Button variant="destructive" size="sm" onClick={() => setVanishStep(2)}>
                    Continue
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="space-y-3 text-sm">
                  <p className="font-medium text-red-500">Are you absolutely sure?</p>
                  <p className="text-muted-foreground text-xs">
                    This is permanent. Your Nostr identity and all associated data will be deleted from relays.
                    There is no recovery. Your secret key will still exist but your profile will be gone.
                  </p>
                </div>
                <div className="flex gap-2 justify-end mt-2">
                  <Button variant="outline" size="sm" onClick={() => setVanishStep(1)} disabled={vanishing}>Back</Button>
                  <Button variant="destructive" size="sm" onClick={handleVanish} disabled={vanishing}>
                    {vanishing ? 'Deleting...' : 'Yes, Delete Everything'}
                  </Button>
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>


        {/* Restore warning dialog — incoming has fewer items than current */}
        <Dialog open={!!pendingRestore} onOpenChange={(open) => !open && setPendingRestore(null)}>
          <DialogContent className="sm:max-w-[400px]" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle className="text-amber-500">Restore Warning</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <p>The backup you're restoring has fewer items than your current data:</p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                {pendingRestore?.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
              <p className="text-xs text-muted-foreground">Your current data will be saved as a checkpoint you can restore later.</p>
            </div>
            <div className="flex gap-2 justify-end mt-2">
              <Button variant="outline" size="sm" onClick={() => setPendingRestore(null)}>Cancel</Button>
              <Button variant="destructive" size="sm" onClick={confirmPendingRestore}>Restore Anyway</Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Checkpoint restore confirmation */}
        <Dialog open={checkpointToRestoreIdx !== null} onOpenChange={(open) => !open && setCheckpointToRestoreIdx(null)}>
          <DialogContent className="sm:max-w-[400px]" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Restore Checkpoint</DialogTitle>
            </DialogHeader>
            {checkpointToRestoreIdx !== null && checkpoints[checkpointToRestoreIdx] && (() => {
              const cp = checkpoints[checkpointToRestoreIdx];
              return (
                <div className="space-y-2 text-sm">
                  <p>Restore from {cp.name || new Date(cp.timestamp * 1000).toLocaleString()}?</p>
                  {cp.stats && (
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <p>{cp.stats.corkboards} corkboards{cp.corkboardNames?.length ? `: ${cp.corkboardNames.join(', ')}` : ''}</p>
                      <p>{cp.stats.savedForLater} saved, {cp.stats.dismissed} dismissed</p>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">This will download and decrypt the backup from Blossom, replacing your current settings.</p>
                </div>
              );
            })()}
            <div className="flex gap-2 justify-end mt-2">
              <Button variant="outline" size="sm" onClick={() => setCheckpointToRestoreIdx(null)}>Cancel</Button>
              <Button size="sm" onClick={() => { if (checkpointToRestoreIdx !== null && checkpoints[checkpointToRestoreIdx]) { loadCheckpointFn(checkpoints[checkpointToRestoreIdx]); setCheckpointToRestoreIdx(null); } }}>Restore</Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Hidden file input for settings restore */}
        <input ref={settingsFileRef} type="file" accept=".json" className="hidden" onChange={handleSettingsRestore} />
      </div>

      {/* Scroll-to-top is now rendered inside StatusBar as a triangle adjacent to the red collapse button */}
    </div>

      {/* Hashtag → open in a new corkboard? */}
      <AlertDialog open={hashtagPrompt !== null} onOpenChange={(open) => { if (!open) setHashtagPrompt(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Open #{hashtagPrompt} in a new corkboard?</AlertDialogTitle>
            <AlertDialogDescription>
              This creates a corkboard that shows notes tagged #{hashtagPrompt}. Your current view stays open.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (hashtagPrompt) confirmOpenHashtagFeed(hashtagPrompt); setHashtagPrompt(null); }}>
              Open corkboard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DeletedAuthorsContext.Provider>
    </HashtagActionContext.Provider>
  );
}

export default MultiColumnClient;