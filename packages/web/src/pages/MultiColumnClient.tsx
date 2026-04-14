import { useState, useEffect, useMemo, useCallback, useRef, useTransition, lazy, Suspense } from 'react';
import { useSeoMeta } from '@unhead/react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostr } from '@/hooks/useNostr';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useImageSizeLimitSetting, useAvatarSizeLimitSetting } from '@/hooks/useImageSizeLimit';
import { usePlatformStorage } from '@/hooks/usePlatformStorage';
import { useToast } from '@/hooks/useToast';
import { debugLog, debugWarn } from '@/lib/debug';

import { usePinnedNotes } from '@/hooks/usePinnedNotes';
import { useParentNotes } from '@/hooks/useParentNotes';
import { useDiscover } from '@/hooks/useDiscover';
import { useOnboardDiscover } from '@/hooks/useOnboardDiscover';
import { useOnboardFollowActivity } from '@/hooks/useOnboardFollowActivity';
import { OnboardSearchWidget } from '@/components/OnboardSearchWidget';
import { useFollowNotesCache } from '@/hooks/useFollowNotesCache';
import { useCustomFeedNotesCache } from '@/hooks/useCustomFeedNotesCache';
import { useBulkAuthors } from '@/hooks/useBulkAuthors';
import { useRelayFeed } from '@/hooks/useRelayFeed';
import { useRssFeed } from '@/hooks/useRssFeed';
import { ToastBar, useFeedToast } from '@/components/ToastBar';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { nip19 } from 'nostr-tools';
import { type NostrEvent } from '@nostrify/nostrify';
import { useNip65Relays } from '@/hooks/useNip65Relays';
import { useIsMobile } from '@/hooks/useIsMobile';
import { classifyNote, type NoteClassification } from '@/lib/noteClassifier';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { ProfileCard } from '@/components/ProfileCard';
import { ThreadPanel } from '@/components/thread'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { genUserName } from '@/lib/genUserName';
import type { KindFilter } from '@/components/NoteKindToggles';
import { ALL_NOTE_KIND_FILTERS } from '@/components/NoteKindToggles';
import type { ContentFilterConfig, ContentFilterKey } from '@/components/ContentFilters';
import { socialUrlToRss } from '@core/rss';
import {
  profileModalState,
  PROFILE_ACTION_NEW_CORKBOARD,
  PROFILE_ACTION_ADD_TO_CORKBOARD,
  PROFILE_ACTION_FOLLOW,
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
import { PenSquare, Settings, Sun, Moon, Wallet, UserPlus, UserCheck, LogOut, Pin, Download, Upload, Trash2, HardDrive, CloudUpload, Volume2, Smile, Loader2, SlidersHorizontal, RefreshCw, Wifi, Server } from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';
import { useAppContext } from '@/hooks/useAppContext';
import { useRelayHealth } from '@/hooks/useRelayHealth';
import { useRetryFailedNotes } from '@/hooks/useRetryFailedNotes';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from '@/components/ui/dropdown-menu';
import { useCollapsedNotes, BOOKMARK_SYNC_EVENT, clearCollapsedNotesModuleState } from '@/hooks/useCollapsedNotes';
import { useNotificationCount } from '@/hooks/useNotificationCount';
import { useBookmarks } from '@/hooks/useBookmarks';
import { ZapDialog } from '@/components/ZapDialog';
import { WalletSettings } from '@/components/WalletSettings';
import { EditProfileForm } from '@/components/EditProfileForm';
import { ProfileCacheSettings } from '@/components/ProfileCacheSettings';
import { ThroughputSettings } from '@/components/ThroughputSettings';
import { AdvancedSettings } from '@/components/AdvancedSettings';
import { EmojiSetEditor } from '@/components/EmojiSetEditor';
import { useNostrBackup } from '@/hooks/useNostrBackup';
import { getActiveUserPubkey, clearActiveUserData, switchActiveUser, STORAGE_KEYS } from '@/lib/storageKeys';
import { idbGetSync, idbSetSync, idbSet } from '@/lib/idb';
import { getCachedProfiles, setCachedProfiles, getProfilesNeedingRefresh, markProfileRefreshed } from '@/lib/profileCache';

import { TIPS } from '@/lib/tips';
import { BackupDownloadPrompt } from '@/components/BackupDownloadPrompt';
import { downloadSettingsBackup, shouldPromptBackupDownload, restoreFromBackupFile, preflightRestore, saveCheckpoint } from '@/lib/downloadBackup';
import { useNostrCustomFeedsSync } from '@/hooks/useNostrCustomFeedsSync';
import { useNostrDismissedSync } from '@/hooks/useNostrDismissedSync';
import { FEED_KINDS } from '@/lib/feedUtils';
// NostrProvider relay utilities used by components but no longer needed in this file
import { getCacheStatsForPubkeys, clearNotesCache } from '@/lib/notesCache';
import { clearRelayCache } from '@/components/NostrProvider';
import { clearMemCache as clearProfileMemCache, evictCachedProfile } from '@/lib/cacheStore';
import { useFeedLimit } from '@/hooks/useFeedLimit';
import { useFeedPagination } from '@/hooks/useFeedPagination';
import { FeedGrid } from '@/components/FeedGrid';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { FeedInfoCard } from '@/components/FeedInfoCard';
import { StatusBar } from '@/components/StatusBar';
import { TabBar } from '@/components/TabBar';
import { NotificationsCorkboard } from '@/components/NotificationsCorkboard';
import { RelayHealthIndicator } from '@/components/RelayHealthIndicator';



// Feed utilities imported from feedUtils above

// Video URL patterns for content-based video detection
const VIDEO_URL_PATTERNS = [
  /youtube\.com\/watch/i,
  /youtu\.be\//i,
  /youtube\.com\/shorts\//i,
  /youtube\.com\/embed\//i,
  /youtube\.com\/live\//i,
  /rumble\.com\/v[\w-]/i,
  /rumble\.com\/embed\//i,
  /tiktok\.com\/.+\/video\//i,
  /vimeo\.com\/\d/i,
  /dailymotion\.com\/video\//i,
  /twitch\.tv\/videos\//i,
  /twitch\.tv\/\w+\/clip\//i,
  /clips\.twitch\.tv\//i,
  /odysee\.com\/@/i,
  /bitchute\.com\/video\//i,
  /video\.nostr\.build\//i,
  /\.mp4\b/i,     // .mp4 anywhere (before query, path segment, etc.)
  /\.mp3\b/i,     // audio (treat as media)
  /\.webm\b/i,
  /\.mov\b/i,
  /\.m4v\b/i,
  /\.m3u8\b/i,
];

// Definitive image file extensions
const IMAGE_EXT_PATTERN = /\.(jpg|jpeg|png|webp|svg|bmp|ico|gif)\b/i;

// CDN domains that host images — only match when URL has an image extension
// or when no video extension is present (ambiguous CDN URLs)
const IMAGE_CDN_PATTERNS = [
  /nostr\.build\/i\//i,
  /image\.nostr\.build\//i,
  /i\.nostr\.build\//i,
  /imgprxy\.stacker\.news\//i,
];

// Video file extension pattern — used to exclude video URLs from image CDN matching
const VIDEO_EXT_EXCLUDE = /\.(mp4|webm|mov|m4v|m3u8|mp3|ogg)\b/i;

// Generic media CDNs — match only if the URL has an image extension (not ambiguous)
const AMBIGUOUS_CDN_PATTERNS = [
  /blossom\.band\//i,
  /blossom\.yakihonne\.com\//i,
  /blossom\.f7z\.io\//i,
  /blossom\.ditto\.pub\//i,
  /blossom\.primal\.net\//i,
  /files\.primal\.net\//i,
  /cdn\.satellite\.earth\//i,
  /cdn\.sovbit\.host\//i,
  /void\.cat\//i,
  /media\.nostr\.band\//i,
];

// Content-filter regexes — hoisted to module scope so they are compiled once, not per-render
const FILTER_EMOJI_ONLY = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s\uFE0F\u200D]+$/u;
const FILTER_URL_ONLY = /^\s*(https?:\/\/\S+\s*)+$/i;
const FILTER_MEDIA_URL = /\.(jpg|jpeg|png|gif|webp|mp4|webm|mov|ogg|svg)\b/i;
const FILTER_HTML_PATTERN = /<\/?[a-z][\s\S]*?>/i;
const FILTER_MD_PATTERN = /(\[.+?\]\(.+?\)|^#{1,6}\s|^\*{1,3}.+?\*{1,3}$|^[-*+]\s|!\[|^>\s|```)/m;

// Check if a note contains video content (by kind or URL)
function hasVideoContent(note: NostrEvent): boolean {
  if (note.kind === 34235 || note.kind === 34236) return true;
  const content = note.content || '';
  // Also check imeta tags for video
  if (note.tags.some(t => t[0] === 'imeta' && t.some(v => /video/i.test(v)))) return true;
  return VIDEO_URL_PATTERNS.some(pattern => pattern.test(content));
}

// Check if a note contains image content (by URL patterns in content or imeta tags).
// Checks each URL individually to avoid false negatives when a note contains both
// an image from an ambiguous CDN and a video URL from elsewhere.
function hasImageContent(note: NostrEvent): boolean {
  const content = note.content || '';
  // Check imeta tags for images
  if (note.tags.some(t => t[0] === 'imeta' && t.some(v => /image/i.test(v)))) return true;
  // Definitive image extension anywhere in content
  if (IMAGE_EXT_PATTERN.test(content)) return true;
  // Image-specific CDN paths (always images)
  if (IMAGE_CDN_PATTERNS.some(p => p.test(content))) return true;
  // Ambiguous CDNs: check each URL individually — only exclude if THAT URL has a video extension
  const urls = content.match(/https?:\/\/\S+/g);
  if (urls) {
    for (const url of urls) {
      if (AMBIGUOUS_CDN_PATTERNS.some(p => p.test(url)) && !VIDEO_EXT_EXCLUDE.test(url)) return true;
    }
  }
  return false;
}

// Classify a note into ALL applicable categories (a note can be in multiple).
// E.g. a reaction to a video counts as both a reaction and a video.
function getNoteCategories(event: NostrEvent, lookup?: Map<string, NostrEvent>): Set<string> {
  const cats = new Set<string>();
  const repostedKind = event.kind === 16 ? parseInt(event.tags.find(t => t[0] === 'k')?.[1] || '0', 10) : 0;

  // For reactions/reposts, check the TARGET note's content too
  const targetId = (event.kind === 7 || event.kind === 9735 || event.kind === 6 || event.kind === 16)
    ? event.tags.find(t => t[0] === 'e')?.[1]
    : null;
  let targetEvent = targetId && lookup ? lookup.get(targetId) : null;
  // For kind 6 reposts, the embedded JSON in content IS the target
  if (!targetEvent && (event.kind === 6 || event.kind === 16) && event.content?.startsWith('{')) {
    try { targetEvent = JSON.parse(event.content) as NostrEvent; } catch { /* not JSON */ }
  }

  // Video: kind 34235, 34236, video URLs, repost of video, or reaction to video
  if (hasVideoContent(event) || repostedKind === 34235 || repostedKind === 34236 || (targetEvent && hasVideoContent(targetEvent))) {
    cats.add('videos');
  }

  // Image: image URLs in content, or reaction/repost targeting an image
  if (hasImageContent(event) || (targetEvent && hasImageContent(targetEvent))) {
    cats.add('images');
  }

  // Recipe: kind 30023 with recipe tag
  if (event.kind === 30023 && event.tags.some(t =>
    (t[0] === 'r' && t[1]?.includes('zap.cooking')) || (t[0] === 't' && t[1] === 'recipe')
  )) {
    cats.add('recipes');
  }

  // Repost (kind 6 or 16)
  if (event.kind === 6 || event.kind === 16) cats.add('reposts');

  // Reaction (kind 7) or zap receipt (kind 9735)
  if (event.kind === 7 || event.kind === 9735) cats.add('reactions');

  // Highlight
  if (event.kind === 9802) cats.add('highlights');

  // Article (kind 30023, not already a recipe)
  if (event.kind === 30023 && !cats.has('recipes')) cats.add('longForm');

  // Short note or reply (kind 1)
  if (event.kind === 1) {
    const hasETags = event.tags.some(t => t[0] === 'e');
    cats.add(hasETags ? 'replies' : 'shortNotes');
  }

  if (cats.size === 0) cats.add('other');
  return cats;
}

// ─── Hashtag extraction helpers ──────────────────────────────────────────────
// Used by both hashtag filtering and hashtag count computation.

/** Extract hashtags from a note's tags and content. */
function getNoteHashtags(note: NostrEvent): Set<string> {
  const tags = new Set<string>();
  for (const t of note.tags) {
    if (t[0] === 't' && t[1]) tags.add(t[1].toLowerCase());
  }
  for (const match of note.content.matchAll(/#([a-zA-Z]\w*)/g)) {
    tags.add(match[1].toLowerCase());
  }
  return tags;
}

/** Extract hashtags from a repost's embedded JSON content. */
function getRepostHashtags(note: NostrEvent): Set<string> {
  if ((note.kind !== 6 && note.kind !== 16) || !note.content) return new Set();
  try {
    const embedded = JSON.parse(note.content);
    const tags = new Set<string>();
    if (Array.isArray(embedded.tags)) {
      for (const t of embedded.tags) {
        if (Array.isArray(t) && t[0] === 't' && typeof t[1] === 'string') {
          tags.add(t[1].toLowerCase());
        }
      }
    }
    if (typeof embedded.content === 'string') {
      for (const match of embedded.content.matchAll(/#([a-zA-Z]\w*)/g)) {
        tags.add(match[1].toLowerCase());
      }
    }
    return tags;
  } catch { return new Set(); }
}

/** Check if a note matches any of the selected hashtag filters. */
function noteMatchesHashtags(note: NostrEvent, selectedHashtags: Set<string>): boolean {
  const hashtags = (note.kind === 6 || note.kind === 16)
    ? getRepostHashtags(note)
    : getNoteHashtags(note);
  for (const tag of hashtags) {
    if (selectedHashtags.has(tag)) return true;
  }
  return false;
}

/** Compute hashtag counts from a set of notes. */
function computeHashtagCounts(notes: NostrEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const note of notes) {
    const tags = (note.kind === 6 || note.kind === 16)
      ? getRepostHashtags(note)
      : getNoteHashtags(note);
    for (const tag of tags) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return counts;
}

// Compute note kind statistics — notes count in ALL applicable categories.
function computeNoteKindStats(events: NostrEvent[] | undefined, lookup?: Map<string, NostrEvent>) {
  if (!events || events.length === 0) return undefined;

  const stats = {
    total: events.length, shortNotes: 0, replies: 0, longForm: 0,
    reposts: 0, reactions: 0, videos: 0, images: 0, highlights: 0, recipes: 0, other: 0
  };

  for (const event of events) {
    const cats = getNoteCategories(event, lookup);
    for (const cat of cats) {
      (stats as Record<string, number>)[cat]++;
    }
  }

  return stats;
}

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
    keywords: 'corkboard, social feed, feed reader, notecards, private, uncensorable, nostr',
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

  // Per-user isolation: wipe any stale session data and mark the active user.
  // This runs whenever the logged-in pubkey changes (including on first login).
  //
  // Safety: after a backup restore + reload, activePubkey === user.pubkey (restore
  // doesn't clear the marker), so this block doesn't run and restored data is safe.
  // After nuclear logout, IDB is empty, so clearActiveUserData() is a no-op.
  // In all other cases (failed logout, race conditions) it wipes stale data.
  useEffect(() => {
    if (!user?.pubkey) return;
    const activePubkey = getActiveUserPubkey();
    if (activePubkey !== user.pubkey) {
      // Wipe EVERYTHING from the previous user — IDB keys, notes cache, query cache,
      // in-memory caches, session state, and relay routing data.
      clearActiveUserData();
      idbSetSync('corkboard:active-user-pubkey', user.pubkey);
      idbSet('corkboard:active-user-pubkey', user.pubkey).catch(() => {});
      clearNotesCache();
      clearRelayCache();
      clearProfileMemCache();
      clearCollapsedNotesModuleState();
      // Clear session-scoped state that isn't per-user keyed
      try {
        sessionStorage.removeItem('corkboard:scroll-positions');
        sessionStorage.removeItem('corkboard:active-tab');
        sessionStorage.removeItem('corkboard:new-user');
        sessionStorage.removeItem('corkboard:soft-dismissed');
        sessionStorage.removeItem('corkboard:session-collapsed');
        sessionStorage.removeItem('corkboard:skip-backup-check');
      } catch { /* sessionStorage may be unavailable */ }
      // Nuke the ENTIRE TanStack Query cache — kills cached profiles, contact
      // lists, notes, and everything else fetched from Nostr for the old user.
      queryClient.clear();
      // Evict the new user's own profile from IDB so it's always fetched fresh
      // from relays (not served from a 48h cache with stale avatar/banner).
      evictCachedProfile(user.pubkey).catch(() => {});
    }
  }, [user?.pubkey, queryClient]);
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
  // Preserve scroll position per tab so switching back restores reading position
  const tabScrollPositions = useRef((() => {
    try {
      const saved = sessionStorage.getItem('corkboard:scroll-positions');
      return saved ? new Map<string, number>(JSON.parse(saved)) : new Map<string, number>();
    } catch { return new Map<string, number>(); }
  })());
  // Persist scroll positions to sessionStorage periodically
  const persistScrollPositions = useRef<ReturnType<typeof setTimeout>>();
  const scheduleScrollPersist = useCallback(() => {
    if (persistScrollPositions.current) clearTimeout(persistScrollPositions.current);
    persistScrollPositions.current = setTimeout(() => {
      try {
        sessionStorage.setItem('corkboard:scroll-positions',
          JSON.stringify(Array.from(tabScrollPositions.current.entries())));
      } catch { /* empty */ }
    }, 1000);
  }, []);
  const activeTabRef2 = useRef(activeTab); // track previous tab for scroll save
  // Flag to suppress scroll-to-note after tab switch (so autofetch doesn't override)
  const suppressScrollTargetUntil = useRef(0);
  const setActiveTab = useCallback((tab: string) => {
    // Save current scroll position for the tab we're leaving
    tabScrollPositions.current.set(activeTabRef2.current, window.scrollY);
    activeTabRef2.current = tab;
    // Suppress scroll targets for 2s after tab switch so autofetch doesn't override
    suppressScrollTargetUntil.current = Date.now() + 2000;
    sessionStorage.setItem('corkboard:active-tab', tab);
    // Update optimistic tab instantly for visual feedback
    setOptimisticTab(tab);
    if (tab === 'notifications') markNotificationsSeen();
    // Wrap heavy state update in transition so content re-renders in background
    startTabTransition(() => {
      setActiveTabRaw(tab);
    });
    // Restore scroll position after content renders — retry until DOM settles
    const savedPos = tabScrollPositions.current.get(tab) ?? 0;
    let attempts = 0;
    const tryRestore = () => {
      window.scrollTo(0, savedPos);
      attempts++;
      // Retry a few times as content may still be loading
      if (attempts < 5) requestAnimationFrame(tryRestore);
    };
    requestAnimationFrame(tryRestore);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- markNotificationsSeen declared after this hook (forward ref)
  }, [startTabTransition]);
  // Continuously save scroll position for current tab so it's always up-to-date
  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          tabScrollPositions.current.set(activeTab, window.scrollY);
          scheduleScrollPersist();
          setScrolledFromTop(window.scrollY > 0);
          ticking = false;
        });
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [activeTab, scheduleScrollPersist]);

  // On initial mount, restore scroll position from sessionStorage after content renders.
  // Mobile browsers may evict the page when backgrounded — when it reloads, content
  // takes time to arrive from relays. We retry with escalating delays (up to 5s total)
  // so the scroll restore succeeds once the document is tall enough.
  useEffect(() => {
    const savedPos = tabScrollPositions.current.get(activeTab) ?? 0;
    if (savedPos <= 0) return;
    let cancelled = false;
    // Phase 1: quick rAF burst for fast restores
    let rAFCount = 0;
    const tryRAF = () => {
      if (cancelled) return;
      window.scrollTo(0, savedPos);
      rAFCount++;
      if (Math.abs(window.scrollY - savedPos) < 20) return;
      if (rAFCount < 8) requestAnimationFrame(tryRAF);
    };
    requestAnimationFrame(tryRAF);
    // Phase 2: slower polling for content-dependent restores (mobile bg return)
    const pollTimer = setInterval(() => {
      if (cancelled) return;
      if (document.body.scrollHeight >= savedPos + window.innerHeight * 0.5) {
        window.scrollTo(0, savedPos);
        clearInterval(pollTimer);
      }
    }, 200);
    // Give up after 5s
    const giveUpTimer = setTimeout(() => { clearInterval(pollTimer); }, 5000);
    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      clearTimeout(giveUpTimer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only on mount

  // Also restore scroll position when returning from background (visibilitychange)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const savedPos = tabScrollPositions.current.get(activeTabRef2.current) ?? 0;
      if (savedPos > 0 && Math.abs(window.scrollY - savedPos) > 50) {
        // Content may have been re-rendered; nudge scroll back
        requestAnimationFrame(() => window.scrollTo(0, savedPos));
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const [defaultColumnCount, _setDefaultColumnCount] = usePlatformStorage<number>(STORAGE_KEYS.DEFAULT_COLUMN_COUNT, 3);
  const [featuresModalOpen, setFeaturesModalOpen] = useState(false);
  const [addAccountDialogOpen, setAddAccountDialogOpen] = useState(false);
  // Track login count so we detect when a new account is added.
  // When a second account is added, force a reload to trigger backup restore
  // and land on the 'me' tab for the new account.
  const prevLoginCountRef = useRef(allLogins.length);
  const prevUserPubkeyRef = useRef(user?.pubkey);
  useEffect(() => {
    const prevCount = prevLoginCountRef.current;
    const prevPubkey = prevUserPubkeyRef.current;
    prevLoginCountRef.current = allLogins.length;
    prevUserPubkeyRef.current = user?.pubkey;
    // Detect new login added (count increased) with multiple accounts
    if (allLogins.length > prevCount && allLogins.length > 1) {
      setAddAccountDialogOpen(false);
      // @nostrify/react auto-activates the new login, so user?.pubkey may
      // already be the new account. If so, we need to do the storage swap
      // and reload manually since switchToAccount guards against same-pubkey.
      if (user?.pubkey && user.pubkey !== prevPubkey && prevPubkey) {
        // New account is already active in @nostrify — just do the storage swap + reload
        switchActiveUser(prevPubkey, user.pubkey);
        window.location.reload();
      } else {
        // Fallback: explicitly switch to the newest login
        const newestLogin = allLogins[allLogins.length - 1];
        if (newestLogin) switchToAccount(newestLogin.id);
      }
    }
  }, [allLogins, user?.pubkey, switchToAccount]);
  const [scrolledFromTop, setScrolledFromTop] = useState(false);
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
  const [threadEventId, setThreadEventId] = useState<string | null>(null);
  const [isThreadModalOpen, setIsThreadModalOpen] = useState(false);
  // When set, auto-open reply compose after the thread loads
  const autoReplyNoteRef = useRef<NostrEvent | null>(null);

  const openThread = (eventId: string) => {
    autoReplyNoteRef.current = null;
    setThreadEventId(eventId);
    setIsThreadModalOpen(true);
  };

  const openThreadAndReply = useCallback((note: NostrEvent) => {
    autoReplyNoteRef.current = note;
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
  const [hasMoreFollows, _setHasMoreFollows] = useState(true);
  const [isLoadingMoreFollows, setIsLoadingMoreFollows] = useState(false);

  // Zap dialog state
  const [zapTargetNote, setZapTargetNote] = useState<NostrEvent | null>(null);
  const [walletSettingsOpen, setWalletSettingsOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [profileCacheSettingsOpen, setProfileCacheSettingsOpen] = useState(false);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [advancedSection, setAdvancedSection] = useState<'main' | 'relays' | 'blossom'>('main');
  const [emojiSetsOpen, setEmojiSetsOpen] = useState(false);
  const [consolidateSound, setConsolidateSound] = useLocalStorage<string>('corkboard:consolidate-sound', 'solitaire');
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
  const { dismissedCount, isDismissed, isCollapsedThisSession, isSoftDismissed, consolidate: rawConsolidate, clearDismissed, collapsedCount: _collapsedCount, collapsedIds, dismiss } = useCollapsedNotes();
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
  const { backupStatus, backupMessage, remoteBackup, loadRemoteBackup, dismissRemoteBackup, saveBackup, autoSaveBackup, downloadBackupAsFile, checkRemoteBackup, lastBackupTs, hasUnsavedChanges, checkpoints, loadCheckpoint: loadCheckpointFn, logs: backupLogs, scanOlderStates, isScanning } = useNostrBackup(user, nostr);

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
        const saved = await autoSaveBackup();
        if (saved) {
          logLogout('Backup saved to Blossom.');
        } else {
          const lastTs = lastBackupTs;
          if (lastTs) {
            const ago = Math.round((Date.now() / 1000 - lastTs) / 60);
            logLogout(`Blossom save failed. Last saved ${ago < 1 ? 'just now' : `${ago}m ago`}.`);
          } else {
            logLogout('Blossom save failed. No previous backup found.');
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

  // Encrypted per-kind sync (corkboards + dismissed notes)
  const _customFeedsSync = useNostrCustomFeedsSync(user, nostr);
  const _dismissedSync = useNostrDismissedSync(user, nostr);

  const _backupTs = lastBackupTs; // read so React re-renders after saves
  const hasChanges = user ? hasUnsavedChanges() : false;

  // No blocking delay — app loads immediately, backup is purely background.
  const canLoadNotes = !!user;
  useEffect(() => { if (canLoadNotes) setProfileFetchEnabled(true); }, [canLoadNotes]);

  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [showBackupConfirm, setShowBackupConfirm] = useState(false);
  const [backupSaveFlash, setBackupSaveFlash] = useState(false);
  const [showDownloadPrompt, setShowDownloadPrompt] = useState(false);

  // Soft refresh: re-fetch broken avatars/nicknames and failed notes without disrupting the UI
  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleSoftRefresh = useCallback(() => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    // Re-fetch authors with empty/missing metadata (broken avatars & nicknames)
    queryClient.invalidateQueries({
      queryKey: ['author'],
      predicate: (query) => {
        const data = query.state.data as { metadata?: Record<string, unknown> } | undefined;
        return query.state.status === 'error' || !data?.metadata || Object.keys(data.metadata).length === 0;
      },
    });
    // Re-fetch notes that errored (content that failed to load)
    queryClient.invalidateQueries({
      queryKey: ['note'],
      predicate: (query) => query.state.status === 'error',
    });
    setTimeout(() => setIsRefreshing(false), 2000);
  }, [isRefreshing, queryClient]);

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

  // Auto-save: triggers 2 minutes after the last data change, not after idle.
  // Polls every 30s to check if unsaved changes exist and enough time has passed.
  // Also triggers immediately on visibilitychange to 'hidden' (tab switch, mobile bg).
  useEffect(() => {
    if (!user) return;

    const MIN_BLOSSOM_INTERVAL_MS = 30 * 1000;
    // Track when we first detected unsaved changes (null = no pending changes)
    let changeDetectedAt: number | null = null;

    const triggerBlossomIfReady = (source: string) => {
      // Never auto-save while a restore is in progress or just found.
      if (backupStatus === 'found' || backupStatus === 'restoring' || backupStatus === 'restored') {
        debugLog(`[AutoSave] skip (${source}): backup ${backupStatus}, waiting for restore to complete`);
        return;
      }
      const lastUploadMs = (lastBackupTs ?? 0) * 1000;
      const msSinceLast = Date.now() - lastUploadMs;
      if (msSinceLast < MIN_BLOSSOM_INTERVAL_MS) {
        debugLog(`[AutoSave] skip (${source}): ${Math.round(msSinceLast / 1000)}s since last upload, need ${MIN_BLOSSOM_INTERVAL_MS / 1000}s`);
        return;
      }
      if (!hasUnsavedChanges()) {
        changeDetectedAt = null;
        return;
      }
      // First time we see unsaved changes — record the timestamp
      if (changeDetectedAt === null) {
        changeDetectedAt = Date.now();
        setBackupSaveFlash(false);
        debugLog(`[AutoSave] changes detected (${source}), will save in ${MIN_BLOSSOM_INTERVAL_MS / 1000}s`);
        return;
      }
      // Wait 2 minutes from when changes were first detected
      const msSinceChange = Date.now() - changeDetectedAt;
      if (msSinceChange < MIN_BLOSSOM_INTERVAL_MS) {
        debugLog(`[AutoSave] skip (${source}): ${Math.round(msSinceChange / 1000)}s since change, need ${MIN_BLOSSOM_INTERVAL_MS / 1000}s`);
        return;
      }
      debugLog(`[AutoSave] triggering (${source})`);
      changeDetectedAt = null;
      autoSaveBackup().then((saved) => {
        if (saved) {
          setBackupSaveFlash(true);
        } else {
          debugWarn('[AutoSave] Blossom upload failed');
          toast({
            title: 'Auto-save failed',
            description: 'Could not save to Blossom. Use the backup menu to retry or download a local copy.',
            variant: 'destructive',
          });
        }
      }).catch((e) => debugWarn('[AutoSave] Unexpected error during Blossom auto-save:', e));
    };

    // Force-save immediately on app background/close — bypass the interval check.
    // This ensures cross-device sync has the latest state when the user leaves.
    const onVisibilityHidden = () => {
      if (document.visibilityState === 'hidden' && hasUnsavedChanges()) {
        debugLog('[AutoSave] forcing save on background (cross-device sync)');
        autoSaveBackup().catch(e => debugWarn('[AutoSave] bg save failed:', e));
      }
    };
    const onBeforeUnload = () => {
      if (hasUnsavedChanges()) {
        autoSaveBackup().catch(e => debugWarn('[AutoSave] close save failed:', e));
      }
    };

    // Poll every 30s to detect changes and trigger save after 30s
    const pollInterval = setInterval(() => triggerBlossomIfReady('poll-30s'), 30_000);

    document.addEventListener('visibilitychange', onVisibilityHidden);
    window.addEventListener('beforeunload', onBeforeUnload);
    // Initial check
    triggerBlossomIfReady('mount');
    return () => {
      clearInterval(pollInterval);
      document.removeEventListener('visibilitychange', onVisibilityHidden);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [user, backupStatus, autoSaveBackup, hasUnsavedChanges, lastBackupTs, toast]);

  // Auto-restore after returning from 5+ min of TRUE idle (tab hidden, not just
  // scrolling or watching a video). Fires once per return — not repeatedly.
  const [autoRestoreTarget, setAutoRestoreTarget] = useState<{ checkpoint: typeof checkpoints[0]; reason: string } | null>(null);
  const [autoRestoreCountdown, setAutoRestoreCountdown] = useState<number | null>(null);
  const idleCheckDoneRef = useRef(false);

  useEffect(() => {
    if (!user) return;
    let lastHidden = 0;
    const onVisChange = () => {
      if (document.visibilityState === 'hidden') {
        lastHidden = Date.now();
        idleCheckDoneRef.current = false; // reset so next return can check
      } else if (document.visibilityState === 'visible' && lastHidden > 0 && !idleCheckDoneRef.current) {
        const awayMs = Date.now() - lastHidden;
        if (awayMs >= 5 * 60 * 1000) {
          idleCheckDoneRef.current = true; // only once per return
          // Silent background check — find newest checkpoint and auto-restore if ahead
          checkRemoteBackup(true).then(() => {
            const cps = checkpoints;
            if (!cps.length) return;
            let best: typeof cps[0] | null = null;
            let bestDismissed = dismissedCount;
            for (const cp of cps) {
              const d = cp.stats?.dismissed ?? 0;
              if (d > bestDismissed) { best = cp; bestDismissed = d; }
            }
            if (best && (bestDismissed - dismissedCount) > 5) {
              setAutoRestoreTarget({ checkpoint: best, reason: `Newer backup found (${bestDismissed - dismissedCount} more dismissed)` });
            }
          });
        }
      }
    };
    document.addEventListener('visibilitychange', onVisChange);
    return () => document.removeEventListener('visibilitychange', onVisChange);
  }, [user, checkRemoteBackup, checkpoints, dismissedCount]);

  // Countdown timer for auto-restore
  useEffect(() => {
    if (!autoRestoreTarget) { setAutoRestoreCountdown(null); return; }
    setAutoRestoreCountdown(5);
    const timer = setInterval(() => {
      setAutoRestoreCountdown(prev => {
        if (prev === null || prev <= 1) { clearInterval(timer); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [autoRestoreTarget]);

  // Auto-load when countdown hits 0
  useEffect(() => {
    if (autoRestoreCountdown !== 0 || !autoRestoreTarget) return;
    loadCheckpointFn(autoRestoreTarget.checkpoint);
    setAutoRestoreTarget(null);
  }, [autoRestoreCountdown, autoRestoreTarget, loadCheckpointFn]);

  // Theme management
  const { theme, setTheme } = useTheme();
  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  // App config (for settings like publishClientTag)
  const { config: appConfig, updateConfig } = useAppContext();

  // Relay health for splash screen - also trigger check on mount
  const { relayHealth: _relayHealth, checkAllRelays, activeRelays: _activeRelays } = useRelayHealth();

  // After page load settles, retry any referenced notes that failed on first attempt
  useRetryFailedNotes();



  // Check relays on mount
  useEffect(() => {
    checkAllRelays();
  }, [checkAllRelays]);

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
  const showOwnNotes = currentTabSettings.showOwnNotes ?? false;
  const showPinned = currentTabSettings.showPinned ?? true;
  const showUnpinned = currentTabSettings.showUnpinned ?? true;

  // Kind/hashtag filters are Sets (for efficient lookup in filter logic)
  const kindFilters = useMemo(() => new Set<KindFilter>((currentTabSettings.kindFilters ?? []) as KindFilter[]), [currentTabSettings]);
  const filterMode: 'any' | 'strict' = currentTabSettings.filterMode ?? 'any';
  const hashtagFilters = useMemo(() => new Set<string>(currentTabSettings.hashtagFilters ?? []), [currentTabSettings]);

  // Content filter config object for ContentFilters component
  const contentFilterConfig = useMemo<ContentFilterConfig>(() => ({
    hideMinChars, hideOnlyEmoji, hideOnlyMedia, hideOnlyLinks,
    hideMarkdown, hideExactText, allowPV, allowGM, allowGN, allowEyes, allow100,
  }), [hideMinChars, hideOnlyEmoji, hideOnlyMedia, hideOnlyLinks, hideMarkdown, hideExactText, allowPV, allowGM, allowGN, allowEyes, allow100]);

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
  const parseFeedSource = useCallback((raw: string): { type: 'relay' | 'rss' | 'pubkey' | 'hashtag'; value: string; platform?: string; label?: string } | null => {
    const input = raw.trim();
    if (!input) return null;

    // Hashtags: #bitcoin or just bitcoin (if it looks like a tag)
    if (input.startsWith('#') && input.length > 1 && /^#[\w]+$/.test(input)) {
      return { type: 'hashtag', value: input.slice(1).toLowerCase() };
    }

    if (input.startsWith('wss://') || input.startsWith('ws://')) {
      return { type: 'relay', value: input };
    }
    if (input.startsWith('http://') || input.startsWith('https://')) {
      // Try social media URL → RSS conversion first
      const social = socialUrlToRss(input);
      if (social) {
        return { type: 'rss', value: social.rssUrl, platform: social.platform, label: social.label };
      }
      return { type: 'rss', value: input };
    }
    // Bare domain/URL without protocol — auto-prepend https://
    if (input.includes('.') && !input.startsWith('npub') && !input.startsWith('nprofile')) {
      const withProto = 'https://' + input;
      const social = socialUrlToRss(withProto);
      if (social) {
        return { type: 'rss', value: social.rssUrl, platform: social.platform, label: social.label };
      }
      return { type: 'rss', value: withProto };
    }
    try {
      const decoded = nip19.decode(input);
      if (decoded.type === 'npub') return { type: 'pubkey', value: decoded.data as string };
      if (decoded.type === 'nprofile') return { type: 'pubkey', value: (decoded.data as { pubkey: string }).pubkey };
    } catch {
      if (input.length === 64 && /^[a-f0-9]+$/.test(input)) {
        return { type: 'pubkey', value: input };
      }
    }
    return null;
  }, []);

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
        // Notify when a social media URL was auto-converted
        if (parsed.platform) {
          toast({ title: `${parsed.platform} detected`, description: `Converted to RSS feed for ${parsed.label}` });
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

      if (events.length === 0) return [];

      // Kind 3 is replaceable — use the most recent event
      const contactEvent = events.sort((a, b) => b.created_at - a.created_at)[0];
      const contactTags = contactEvent.tags.filter(tag => tag[0] === 'p');
      return contactTags.map(tag => tag[1]); // Extract pubkeys
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

      const authorBatch = contacts.slice(followsOffset, followsOffset + 500);
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
  const isOnboarding = contacts !== undefined && contacts.length < onboardFollowTarget && !onboardingSkipped && !wasRestoredRef.current;

  // Open the edit-profile dialog the first time onboarding completes (contacts reach 10).
  // Skip if onboarding was dismissed via a backup restore (user already set up their profile).
  const onboardingWasActiveRef = useRef(false);
  useEffect(() => {
    if (isOnboarding) {
      onboardingWasActiveRef.current = true;
    } else if (onboardingWasActiveRef.current && !wasRestoredRef.current && !onboardingSkipped) {
      onboardingWasActiveRef.current = false;
      setEditProfileOpen(true);
    }
  }, [isOnboarding, onboardingSkipped]);

  // Auto-switch to discover tab on first contacts load when following fewer than 10 people
  const contactsFirstLoadRef = useRef<string | null>(null);
  useEffect(() => {
    if (contacts === undefined || !user?.pubkey) return;
    // Reset when user changes (account switch)
    if (contactsFirstLoadRef.current === user.pubkey) return;
    contactsFirstLoadRef.current = user.pubkey;
    if (contacts.length < onboardFollowTarget && !onboardingSkipped && (activeTab === 'me' || activeTab === 'discover')) {
      setActiveTab('discover');
    }
  // setActiveTab is stable but not listed to avoid stale-closure lint noise
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts, user?.pubkey]);

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
    setStableDiscoverNotes(prev => [...prev, ...fresh]);
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
  
  // Reset extra notes when user changes (extraUserNotes state is defined earlier in the file)
  useEffect(() => {
    setExtraUserNotes([]);
  }, [user?.pubkey]);

  // Called by loadMoreByCount when it fetches notes for the 'me' tab
  const handleMeTabNotesLoaded = useCallback((notes: NostrEvent[]) => {
    setExtraUserNotes(notes);
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
      const since = now - 3600 * feedLimitMultiplier;
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
  const activeRssUrls = hasRssInCustomFeed ? activeCustomFeed!.rssUrls : [];
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

    // Get notes from custom feed cache (separate from global follow cache)
    const nostrNotes = customFeedNotesData ?? [];
    const htNotes = [...(hashtagNotes ?? []), ...extraHashtagNotes];
    const rss = customFeedRssNotes ?? [];

    // Merge hashtag notes into nostr notes
    const allNostr = [...nostrNotes];
    const seenIds = new Set(nostrNotes.map(n => n.id));
    for (const n of htNotes) {
      if (!seenIds.has(n.id)) { allNostr.push(n); seenIds.add(n.id); }
    }

    debugLog('[corkboard] nostrNotes:', nostrNotes.length, 'hashtagNotes:', htNotes.length, 'rssNotes:', rss.length);

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
  }, [isCustomFeedTab, activeCustomFeed, customFeedNotesData, hashtagNotes, extraHashtagNotes, customFeedRssNotes]);
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
      if (!user?.pubkey || !contacts) return;
      if (contacts.includes(pubkey)) return;

      // Publish updated Kind 3 contact list
      const newContacts = [...contacts, pubkey];
      createEvent({
        kind: 3,
        content: '',
        tags: newContacts.map(pk => ['p', pk]),
      });
      // Optimistically update cached contacts — avoids full feed refetch/scroll reset
      queryClient.setQueryData(['contacts', user.pubkey], newContacts);
      toast({ title: 'Followed', description: 'Contact list updated' });
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
    window.addEventListener(PROFILE_ACTION_MUTE, handleMute);

    return () => {
      window.removeEventListener(PROFILE_ACTION_NEW_CORKBOARD, handleNewCorkboard);
      window.removeEventListener(PROFILE_ACTION_ADD_TO_CORKBOARD, handleAddToCorkboard);
      window.removeEventListener(PROFILE_ACTION_FOLLOW, handleFollow);
      window.removeEventListener(PROFILE_ACTION_MUTE, handleMute);
    };
  }, [contacts, user?.pubkey, createEvent, queryClient, toast, setCustomFeeds, setActiveTab, mutePubkey, customFeeds]);





  const hasActiveContentFilters = hideMinChars > 0 || hideOnlyEmoji || hideOnlyMedia || hideOnlyLinks || hideHtml || hideMarkdown || hideExactText.length > 0;
  const hasActiveFilters = kindFilters.size > 0 || hashtagFilters.size > 0 || hasActiveContentFilters;

  const discoverStats = useMemo(() => computeNoteKindStats(discoveredNotes), [discoveredNotes]);

  // ─── Feed pagination (load older / load newer) ───────────────────────────
  // currentNotes for the hook: we use a ref to avoid creating a circular
  // dependency (notes → newerNotes → pagination). The ref is updated after each
  // render so load-newer deduplication always sees the latest displayed notes.
  const currentNotesRef = useRef<NostrEvent[]>([]);
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
    showOwnNotes,
  });

  // Wire the pagination setBatchProgress to the stable ref so feed hooks can call it
  useEffect(() => {
    batchProgressCallbackRef.current = _paginationSetBatchProgressInternal;
  }, [_paginationSetBatchProgressInternal]);

  // Autofetch interval: uses stored interval (default 120s)
  const loadNewerRef = useRef(loadNewerNotes);
  loadNewerRef.current = loadNewerNotes;
  const isLoadingRef = useRef(false);
  isLoadingRef.current = isLoadingMore || isLoadingNewer;
  const autofetchTickRef = useRef(0);
  const [lastAutofetchTime, setLastAutofetchTime] = useState<number>(0);
  useEffect(() => {
    if (!autofetch) return;
    autofetchTickRef.current = 0;
    // Fetch immediately when autofetch is turned on
    if (!isLoadingRef.current) {
      loadNewerRef.current();
    }
    setLastAutofetchTime(Date.now());
    const intervalMs = autofetchIntervalSecs * 1000;
    const timer = setInterval(() => {
      if (autofetchRef.current && !isLoadingRef.current) {
        loadNewerRef.current();
        setLastAutofetchTime(Date.now());
        // Refresh notification count every other auto-fetch tick
        if (++autofetchTickRef.current % 2 === 0) {
          queryClient.invalidateQueries({ queryKey: ['notification-count'] });
        }
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }, [autofetch, autofetchIntervalSecs, queryClient]);

  // Autofetch on tab/corkboard switch
  const prevTabRef = useRef(activeTab);
  useEffect(() => {
    if (autofetchRef.current && activeTab !== prevTabRef.current) {
      prevTabRef.current = activeTab;
      // Small delay to let the tab settle before fetching
      const t = setTimeout(() => {
        if (autofetchRef.current) loadNewerNotes();
      }, 500);
      return () => clearTimeout(t);
    }
    prevTabRef.current = activeTab;
  }, [activeTab, loadNewerNotes]);

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

      if (!hasPubkeys && (hasHashtags || hasRss)) {
        if (hasHashtags) {
          // Find the oldest note currently displayed to paginate from
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
  const { deduplicatedNotes, noteClassifications, parentIdsNeeded, eventLookup } = useMemo(() => {
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
      if (hasPinnedOnMe) {
        baseNotes = [];
      } else {
        return { deduplicatedNotes: [] as NostrEvent[], noteClassifications: new Map<string, NoteClassification>(), parentIdsNeeded: [] as string[], eventLookup: new Map<string, NostrEvent>() };
      }
    }

    if (showOwnNotes && activeTab !== 'me' && !isDiscoverTab && user?.pubkey) {
      // On custom feed tabs, don't mix in self-notes until the feed has loaded.
      // Showing only self-notes while waiting for other authors is disorienting.
      const feedStillLoading = isCustomFeedTab && isLoadingCustomFeedNotes && (!baseNotes || baseNotes.length === 0);
      if (!feedStillLoading) {
        // Mix in self notes from follow cache AND userNotes (me-tab source) for reliability.
        // followNotesCache may not always include self notes (relay timing, batch ordering).
        const selfFromCache = followNotesCache?.filter(e => e.pubkey === user.pubkey && !pinnedIdSet.has(e.id)) ?? [];
        const selfFromUserNotes = userNotes?.filter(e => !pinnedIdSet.has(e.id)) ?? [];
        // Merge both sources, dedup by id
        const selfIds = new Set<string>();
        const allSelfNotes: NostrEvent[] = [];
        for (const n of [...selfFromCache, ...selfFromUserNotes]) {
          if (!selfIds.has(n.id)) {
            selfIds.add(n.id);
            allSelfNotes.push(n);
          }
        }
        if (baseNotes && baseNotes.length > 0 && allSelfNotes.length > 0) {
          const oldestTimestamp = baseNotes.reduce((min, n) => n.created_at < min ? n.created_at : min, baseNotes[0].created_at);
          const filteredUserNotes = allSelfNotes.filter(n => n.created_at >= oldestTimestamp);
          baseNotes = [...baseNotes, ...filteredUserNotes];
        }
        // When baseNotes is empty, don't show self notes — there's no time window to filter against
      }
    }

    // Only include pinned notes on 'me' tab; exclude them from all other tabs.
    // Pinned notes come FIRST so the dedup below keeps the pinned version and
    // drops any duplicate that also appears in the regular feed.
    let allNotes: NostrEvent[];
    if (activeTab === 'me') {
      allNotes = [...(pinnedNoteEvents || []), ...baseNotes];
    } else {
      allNotes = pinnedIdSet.size > 0
        ? baseNotes.filter(n => !pinnedIdSet.has(n.id))
        : baseNotes;
    }

    // Collect deletion requests (kind 5) — build set of deleted event IDs
    const deletedNoteIds = new Set<string>();
    for (const note of allNotes) {
      if (note.kind === 5) {
        for (const tag of note.tags) {
          if (tag[0] === 'e') deletedNoteIds.add(tag[1]);
        }
      }
    }

    const DISPLAYABLE_KINDS = new Set([1, 6, 7, 16, 30023, 34235, 34236, 9735, 9802]);
    const displayableNotes = allNotes.filter(note =>
      note.kind !== 5 && DISPLAYABLE_KINDS.has(note.kind)
    ).filter(note => !deletedNoteIds.has(note.id))
     .filter(note => !mutedPubkeys.has(note.pubkey));

    // Build event lookup so getNoteCategories can check reaction/repost targets
    const eventLookup = new Map(displayableNotes.map(n => [n.id, n]));

    const seen = new Set<string>();
    const seenRepostedIds = new Set<string>();
    // Track which original note IDs are referenced by reactions/reposts/zaps
    // so we can suppress the wrapper when the original is already in the feed.
    const referencedOriginalIds = new Set<string>();
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
      // Repost dedup: if we already have the original note in the feed, skip the repost
      if (note.kind === 6 || note.kind === 16) {
        let originalId: string | undefined;
        if (note.content && note.content.startsWith('{')) {
          try { originalId = JSON.parse(note.content).id; } catch { /* ignore */ }
        }
        if (!originalId) {
          const eTag = note.tags.find(t => t[0] === 'e');
          originalId = eTag?.[1];
        }
        if (originalId) {
          if (seen.has(originalId) || seenRepostedIds.has(originalId)) return false;
          seenRepostedIds.add(originalId);
        }
      }
      // Reaction/zap dedup: if the original note they reference is already in the
      // feed as a kind-1 post, suppress the reaction/zap wrapper to avoid showing
      // the same content twice (once as the original, once embedded in the reaction).
      if (note.kind === 7 || note.kind === 9735) {
        const targetId = note.tags.find(t => t[0] === 'e')?.[1];
        if (targetId && eventLookup.has(targetId) && (eventLookup.get(targetId)!.kind === 1 || eventLookup.get(targetId)!.kind === 30023)) {
          return false;
        }
      }
      if (note.kind === 1 && seenRepostedIds.has(note.id)) return false;
      return true;
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
    };
  }, [activeTab, userNotes, friendNotes, relayNotes, customFeedNotes, stableDiscoverNotes, allFollowsNotes, rssNotes, isRelayTab, isCustomFeedTab, isLoadingCustomFeedNotes, isDiscoverTab, isAllFollowsTab, isRssTab, pinnedNoteEvents, showOwnNotes, newerNotes, mutedPubkeys, followNotesCache, pinnedIdSet, user?.pubkey]);

  // ── Bulk Author Prefetch ─────────────────────────────────────────────────────
  // Prefetch author profiles for notes being displayed (up to feedLimit).
  // This populates React Query cache so NoteCards render avatars instantly.
  const { prefetchFromNotes } = useBulkAuthors();
  const prefetchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  useEffect(() => {
    // Debounce prefetch to avoid rapid-fire calls when notes change
    if (prefetchTimeoutRef.current) {
      clearTimeout(prefetchTimeoutRef.current);
    }
    if (!canLoadNotes) return; // Don't prefetch during splash

    prefetchTimeoutRef.current = setTimeout(() => {
      const notesToPrefetch = deduplicatedNotes.slice(0, feedLimit);
      if (notesToPrefetch.length > 0) {
        prefetchFromNotes(notesToPrefetch).catch(err => {
          debugWarn('[MultiColumnClient] Bulk author prefetch failed:', err);
        });
      }
    }, 50); // 50ms debounce — fire fast so profiles arrive before individual useAuthor calls
    
    return () => {
      if (prefetchTimeoutRef.current) {
        clearTimeout(prefetchTimeoutRef.current);
      }
    };
  }, [deduplicatedNotes, feedLimit, prefetchFromNotes, canLoadNotes]);

  // ── Stage 2: Apply filters (re-runs when filters change, but skips dedup/classify) ──
  const { notes, filteredHashtags, hasFilteredNotes, allDismissed } = useMemo(() => {
    if (deduplicatedNotes.length === 0) {
      return { notes: [] as NostrEvent[], filteredHashtags: [] as { tag: string; count: number }[], allDismissed: false };
    }

    // Dismiss filter — skip on 'me' tab (dismissing elsewhere shouldn't hide own notes)
    let filteredNotes = activeTab === 'me'
      ? deduplicatedNotes
      : deduplicatedNotes.filter(note => !isDismissed(note.id));

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

    // Kind filters — two modes:
    // 'any' (default): show if ANY category is enabled (e.g. reaction-to-video shows if reactions OR videos on)
    // 'strict': hide if ANY category is disabled (e.g. reaction-to-video hidden if images off, even if reactions on)
    const categoryToFilter: Record<string, KindFilter> = {
      shortNotes: 'posts', replies: 'replies', longForm: 'articles',
      videos: 'videos', images: 'images', reposts: 'reposts', reactions: 'reactions',
      highlights: 'highlights', recipes: 'recipes', other: 'posts',
    };
    if (kindFilters.size > 0) {
      filteredNotes = filteredNotes.filter(note => {
        const cats = getNoteCategories(note, eventLookup);
        if (filterMode === 'strict') {
          // Strict: hide if ANY of the note's categories is filtered out
          for (const cat of cats) {
            const filter = categoryToFilter[cat];
            if (filter && kindFilters.has(filter)) return false;
          }
          return true;
        } else {
          // Any (default): show if at least one category is NOT filtered out
          for (const cat of cats) {
            const filter = categoryToFilter[cat];
            if (!filter || !kindFilters.has(filter)) return true;
          }
          return false;
        }
      });
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

    // Content filters
    if (hasActiveContentFilters) {
      const exactLower = hideExactText.trim().toLowerCase();
      filteredNotes = filteredNotes.filter(note => {
        if (note.kind !== 1 && note.kind !== 7) return true;
        const trimmed = note.content.trim();
        if (FILTER_EMOJI_ONLY.test(trimmed)) {
          const stripped = trimmed.replace(/[\s\uFE0F\u200D]/gu, '');
          /* eslint-disable no-misleading-character-class */
          if (allowPV && /^[💜🟣]+$/u.test(stripped)) return true;
          if (allowGM && /^[☀️🌅🌄🌞🔆☕]+$/u.test(stripped)) return true;
          if (allowGN && /^[🌙🌃🌌🌛🌜✨💤😴🛌]+$/u.test(stripped)) return true;
          if (allowEyes && /^[👀]+$/u.test(stripped)) return true;
          if (allow100 && /^[💯🔥]+$/u.test(stripped)) return true;
          /* eslint-enable no-misleading-character-class */
        }
        if (hideMinChars > 0 && trimmed.length > 0 && trimmed.length <= hideMinChars) return false;
        if (hideOnlyEmoji && FILTER_EMOJI_ONLY.test(trimmed)) return false;
        if (hideOnlyMedia && FILTER_MEDIA_URL.test(trimmed) && trimmed.replace(/https?:\/\/\S+/g, '').trim().length === 0) return false;
        if (hideOnlyLinks && FILTER_URL_ONLY.test(trimmed)) return false;
        if (hideHtml && FILTER_HTML_PATTERN.test(trimmed)) return false;
        if (hideMarkdown && FILTER_MD_PATTERN.test(trimmed)) return false;
        if (exactLower && trimmed.toLowerCase() === exactLower) return false;
        return true;
      });
    }

    // Sort: pinned first, then by time descending
    const pinned = filteredNotes.filter(note => pinnedIds.includes(note.id));
    const regular = filteredNotes
      .filter(note => !pinnedIds.includes(note.id))
      .sort((a, b) => b.created_at - a.created_at);
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
  }, [deduplicatedNotes, eventLookup, noteClassifications, isDismissed, isOnboarding, isDiscoverTab, kindFilters, filterMode, hashtagFilters, hasActiveContentFilters, hideMinChars, hideOnlyEmoji, allowPV, allowGM, allowGN, allowEyes, allow100, hideOnlyMedia, hideOnlyLinks, hideHtml, hideMarkdown, hideExactText, pinnedIds, pinnedIdSet, showOwnNotes, showPinned, showUnpinned, activeTab, user?.pubkey]);

  // Keep allDismissed ref in sync for handleLoadMoreByCount callback
  allDismissedRef.current = allDismissed;

  // Keep the pagination hook's currentNotes ref in sync after each render
  // (runs synchronously after the useMemo above resolves notes)
  currentNotesRef.current = notes;

  // Stats from deduped notes — these match the visible counts in the kind toggles
  const activeTabStats = useMemo(() => computeNoteKindStats(deduplicatedNotes, eventLookup), [deduplicatedNotes, eventLookup]);

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

  const consolidateSoundRef = useRef(consolidateSound);
  consolidateSoundRef.current = consolidateSound;

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
    // Play consolidate sound effect
    const style = consolidateSoundRef.current;
    const actualBlanks = notes.filter((n, i) => i <= lastBlankIdx && (isCollapsedThisSession(n.id) || isSoftDismissed(n.id))).length;
    if (actualBlanks > 0 && style !== 'off') {
      try {
        const ctx = new AudioContext();
        void ctx.resume();
        const blanks = actualBlanks;
        const count = Math.min(blanks, 2000);
        const duration = Math.min(count * 0.005, 10);
        const spacing = duration / count;

        if (style === 'chimes') {
          // Chime cascade — layered bell tones walking down a pentatonic scale
          const scale = [523, 587, 659, 784, 880, 1047, 1175, 1319, 1568, 1760];
          for (let i = 0; i < count; i++) {
            const t = ctx.currentTime + i * spacing;
            const noteIdx = Math.floor((1 - i / count) * (scale.length - 1));
            const freq = scale[noteIdx] + (Math.random() - 0.5) * 10;
            const osc1 = ctx.createOscillator(); osc1.type = 'sine'; osc1.frequency.value = freq;
            const osc2 = ctx.createOscillator(); osc2.type = 'triangle'; osc2.frequency.value = freq * 3;
            const osc3 = ctx.createOscillator(); osc3.type = 'sine'; osc3.frequency.value = freq * 5.2;
            const g1 = ctx.createGain(); const g2 = ctx.createGain(); const g3 = ctx.createGain();
            g1.gain.setValueAtTime(0.045, t); g1.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
            g2.gain.setValueAtTime(0.011, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.21);
            g3.gain.setValueAtTime(0.004, t); g3.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
            osc1.connect(g1).connect(ctx.destination); osc2.connect(g2).connect(ctx.destination); osc3.connect(g3).connect(ctx.destination);
            osc1.start(t); osc1.stop(t + 0.35); osc2.start(t); osc2.stop(t + 0.21); osc3.start(t); osc3.stop(t + 0.1);
          }
        } else {
          // Solitaire — one short swoosh/shuffle per 3 notes consolidated
          // Spacing accelerates: close together at start, farther apart at end
          // Max gap reaches 0.18s only at 1000+ blanks; below that, proportionally smaller
          const swooshCount = Math.max(1, Math.ceil(blanks / 3));
          const minGap = 0.04;
          const maxGap = Math.min(0.18, 0.18 * (blanks / 1000));
          let elapsed = 0;
          for (let i = 0; i < swooshCount; i++) {
            const t = ctx.currentTime + elapsed;
            const progress = swooshCount > 1 ? i / (swooshCount - 1) : 0;
            elapsed += minGap + (maxGap - minGap) * (progress ** 1.5);
            // Filtered noise swoosh — longer than a click, shorter than wind
            const bufLen = Math.floor(ctx.sampleRate * 0.08);
            const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
            const data = buf.getChannelData(0);
            for (let j = 0; j < bufLen; j++) data[j] = (Math.random() * 2 - 1);
            const noise = ctx.createBufferSource();
            noise.buffer = buf;
            // Highpass to keep it airy, not boomy
            const hp = ctx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = 2000;
            hp.Q.value = 0.5;
            // Bandpass for body
            const bp = ctx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = 4000 + Math.random() * 1000;
            bp.Q.value = 0.7;
            // Envelope: quick fade in, quick fade out — "fft" shape
            const env = ctx.createGain();
            env.gain.setValueAtTime(0.001, t);
            env.gain.linearRampToValueAtTime(0.1125, t + 0.015);
            env.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
            noise.connect(hp).connect(bp).connect(env).connect(ctx.destination);
            noise.start(t); noise.stop(t + 0.08);
          }
        }
      } catch { /* audio not available */ }
    }
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

  // Auto-consolidate and/or scroll to top when autofetch brings in new notes
  const prevFreshCountRef = useRef(freshNoteIds.size);
  useEffect(() => {
    const prevCount = prevFreshCountRef.current;
    prevFreshCountRef.current = freshNoteIds.size;
    // Only trigger when fresh notes increased (new notes arrived) and autofetch is on
    if (!autofetch || freshNoteIds.size <= prevCount) return;
    if (autoConsolidate && blankSpaceCount > 0) {
      // Delay slightly so DOM settles before consolidating
      setTimeout(() => rawConsolidate(), 150);
    }
    if (autoScrollTop) {
      setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), autoConsolidate ? 300 : 150);
    }
  }, [freshNoteIds.size, autofetch, autoConsolidate, autoScrollTop, blankSpaceCount, rawConsolidate]);

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

  const isLoading = isLoadingUserNotes || isLoadingFriendNotes || isLoadingRelayNotes || isLoadingCustomFeed || (isDiscoverTab && isLoadingDiscover && discoveredNotes.length === 0 && (!isOnboarding || isLoadingOnboardSeed)) || (isAllFollowsTab && isLoadingAllFollows);

  // Logout splash — must come before !user check so it stays visible after
  // nuclearWipe() removes the login (user becomes null) and until page reloads.
  if (logoutStep) {
    const isDone = logoutStep === 'done';
    const visibleLogs = logoutLog.slice(-12);
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center z-50">
        <div className="text-center space-y-4 max-w-md px-4 w-full">
          <div className={`text-5xl ${isDone ? '' : 'animate-bounce'}`}>📌</div>
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

  // No backup splash — app loads instantly. Restore is handled by
  // return-from-idle auto-restore or manual Backup & Restore menu.

  return (
    <div className="min-h-screen bg-background">
      <div className="w-full px-4 py-0.5 pb-2 sm:py-1.5 sm:pb-4">
        {/* Header — responsive: stacked on mobile, single row on desktop */}
        {isMobile ? (
          <div className="mb-0.5">
            {/* Mobile: single row — pin, theme, settings, backup, relay | post, avatar */}
            <div className="flex items-center justify-between gap-1">
              <div className="flex items-center gap-1">
                <span className="text-base leading-none px-0.5">📌</span>
                <Button variant="ghost" size="sm" onClick={toggleTheme} className="h-7 w-7 p-0" title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
                  {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0"><Settings className="h-4 w-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => setEditProfileOpen(true)} className="gap-2"><UserPlus className="h-4 w-4" />Customize Profile</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setWalletSettingsOpen(true)} className="gap-2"><Wallet className="h-4 w-4" />Connect Wallet</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setEmojiSetsOpen(true)} className="gap-2"><Smile className="h-4 w-4" />Emoji Sets</DropdownMenuItem>
                    <DropdownMenuSeparator />
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
                      <HardDrive className={`h-4 w-4 transition-all duration-700 ${backupSaveFlash ? 'text-green-500 animate-[backup-pulse_0.8s_ease-in-out_infinite]' : ''}`} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      disabled={backupStatus === 'saving' || backupStatus === 'encrypting'}
                      onClick={async () => {
                        try {
                          await saveBackup();
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
                      // Debounce: don't open during active check/restore
                      if (backupStatus === 'checking' || backupStatus === 'restoring') return;

                      setShowBackupConfirm(true);
                      // Skip re-check if login already found states (check settled recently)
                      if (backupStatus === 'idle' || backupStatus === 'no-backup') {
                        checkRemoteBackup(true);
                      }
                    }} className="gap-2"><HardDrive className="h-4 w-4" />Backup &amp; Restore</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setLocalBackupOpen(true)} className="gap-2"><HardDrive className="h-4 w-4" />Local File Backup</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => { setAdvancedSettingsOpen(true); setAdvancedSection('relays'); }} className="gap-2"><Wifi className="h-4 w-4" />Relays</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => { setAdvancedSettingsOpen(true); setAdvancedSection('blossom'); }} className="gap-2"><Server className="h-4 w-4" />Blossom Servers</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {canLoadNotes && <RelayHealthIndicator />}
                {canLoadNotes && (
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Refresh failed content" onClick={handleSoftRefresh}>
                    <RefreshCw className={`h-3.5 w-3.5 text-muted-foreground ${isRefreshing ? 'animate-spin' : ''}`} />
                  </Button>
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
                    <div className="font-medium text-sm px-2 py-1.5">Switch Account</div>
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
              <span className="text-2xl">📌</span>
              <h1 className="text-2xl font-bold text-purple-600 dark:text-purple-400">corkboards.me</h1>
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
                  <DropdownMenuItem onClick={() => setEditProfileOpen(true)} className="gap-2">
                    <UserPlus className="h-4 w-4" />
                    Customize Profile
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setWalletSettingsOpen(true)} className="gap-2">
                    <Wallet className="h-4 w-4" />
                    Connect Wallet
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setEmojiSetsOpen(true)} className="gap-2">
                    <Smile className="h-4 w-4" />
                    Emoji Sets
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
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
                    <HardDrive className={`h-4 w-4 transition-all duration-700 ${backupSaveFlash ? 'text-green-500 animate-[backup-pulse_0.8s_ease-in-out_infinite]' : ''}`} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => {
                      // Debounce: don't open during active check/restore
                      if (backupStatus === 'checking' || backupStatus === 'restoring') return;

                      setShowBackupConfirm(true);
                      // Skip re-check if login already found states (check settled recently)
                      if (backupStatus === 'idle' || backupStatus === 'no-backup') {
                        checkRemoteBackup(true);
                      }
                    }} className="gap-2">
                    <CloudUpload className="h-4 w-4" />
                    Backup &amp; Restore
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setLocalBackupOpen(true)} className="gap-2">
                    <HardDrive className="h-4 w-4" />
                    Local File Backup
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => { setAdvancedSettingsOpen(true); setAdvancedSection('relays'); }} className="gap-2"><Wifi className="h-4 w-4" />Relays</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setAdvancedSettingsOpen(true); setAdvancedSection('blossom'); }} className="gap-2"><Server className="h-4 w-4" />Blossom Servers</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {canLoadNotes && <RelayHealthIndicator />}
              {canLoadNotes && (
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Refresh failed content" onClick={handleSoftRefresh}>
                  <RefreshCw className={`h-3.5 w-3.5 text-muted-foreground ${isRefreshing ? 'animate-spin' : ''}`} />
                </Button>
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
            <AccountSwitcher onAddAccountClick={() => setAddAccountDialogOpen(true)} onLogout={handleLogout} />
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
                {backupStatus === 'checking' && (
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
                  disabled={isScanning || backupStatus === 'checking'}
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
          <div className={`relative -mx-4 px-2 sm:px-8 py-0.5 sm:py-1.5 bg-gradient-to-r from-gray-100/95 to-gray-200/95 backdrop-blur-sm border-b border-white/20 min-h-[24px] sm:min-h-[28px] ${stickyTabBar ? 'sticky top-0 z-30 shadow-sm' : ''}`}>
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
                    disabled={!contacts}
                    className={`text-xs gap-1 ${contacts?.includes(activeTab) ? 'text-green-600' : 'text-purple-600 hover:text-purple-700'}`}
                    onClick={() => {
                      if (!contacts || !user?.pubkey) return;
                      if (contacts.includes(activeTab)) {
                        const newContacts = contacts.filter(pk => pk !== activeTab);
                        createEvent({ kind: 3, content: '', tags: newContacts.map(pk => ['p', pk]) });
                        queryClient.setQueryData(['contacts', user.pubkey], newContacts);
                        toast({ title: 'Unfollowed', description: 'Contact list updated' });
                      } else {
                        const newContacts = [...contacts, activeTab];
                        createEvent({ kind: 3, content: '', tags: newContacts.map(pk => ['p', pk]) });
                        queryClient.setQueryData(['contacts', user.pubkey], newContacts);
                        toast({ title: 'Followed', description: 'Contact list updated' });
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
                if (!contacts || !user?.pubkey) return;
                const pk = activeCustomFeed!.pubkeys[0];
                if (contacts.includes(pk)) {
                  const newContacts = contacts.filter(c => c !== pk);
                  createEvent({ kind: 3, content: '', tags: newContacts.map(c => ['p', c]) });
                  queryClient.setQueryData(['contacts', user.pubkey], newContacts);
                  toast({ title: 'Unfollowed', description: 'Contact list updated' });
                } else {
                  const newContacts = [...contacts, pk];
                  createEvent({ kind: 3, content: '', tags: newContacts.map(c => ['p', c]) });
                  queryClient.setQueryData(['contacts', user.pubkey], newContacts);
                  toast({ title: 'Followed', description: 'Contact list updated' });
                }
              } : undefined}
              onThreadClick={openThread}
              onOpenThread={openThread}
              columnCount={columnCount}
            />
          )}
        </div>

        {/* Onboard search widget — shown during onboard procedure on discover tab */}
        {isOnboarding && isDiscoverTab && <OnboardSearchWidget contactCount={contacts?.length ?? 0} followTarget={onboardFollowTarget} onSkip={() => { setOnboardingSkipped(true); setActiveTab('me'); autoSaveBackup().then((saved) => { if (saved) { setBackupSaveFlash(true); } else { toast({ title: 'Backup failed', description: 'Onboarding preference could not be saved to cloud. It will retry automatically.', variant: 'destructive' }); } }).catch(() => {}); }} />}

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
          onLoadNewer={isSavedTab ? () => {} : loadNewerNotes}
          onLoadMore={isSavedTab ? () => {} : handleLoadMore}
          onConsolidate={consolidate}
          onThreadClick={openThread}
          onComment={openThreadAndReply}
          onOpenThread={openThread}
          onPinClick={handlePinNote}
          onZapClick={(note) => setZapTargetNote(note)}
          onRepost={(note) => openRepost(note)}
          onPinToBoard={handlePinToBoard}
          onDeleteNote={handleDeleteNote}
          onReactionPublished={handleReactionPublished}
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
          onLoadNewer={isSavedTab ? () => {} : loadNewerNotes}
          onLoadMoreByCount={isSavedTab ? () => {} : handleLoadMoreByCount}
          onConsolidate={consolidate}
          onSave={() => { setShowBackupConfirm(true); checkRemoteBackup(true); }}
          onRestore={() => remoteBackup ? setShowRestoreConfirm(true) : checkRemoteBackup(true)}
          isLoading={isLoadingMore || isLoadingNewer}
          loadingMessage={loadingMessage}
          blankSpaceCount={blankSpaceCount}
          multiplier={feedLimitMultiplier}
          indexedDbStats={isNotificationsTab ? notifStats : (() => {
            const visible = notes.length;
            const dismissed = deduplicatedNotes.filter(n => isDismissed(n.id)).length;
            const filtered = hasActiveFilters ? Math.max(0, deduplicatedNotes.length - notes.length - dismissed) : 0;
            const total = visible + dismissed + filtered;
            return { total, visible, dismissed, filtered };
          })()}
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
              onClick={() => { setAutoRestoreTarget(null); setAutoRestoreCountdown(null); }}
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
          }}
          onQuote={openQuote}
          onRepost={openRepost}
          onZap={(event) => setZapTargetNote(event)}
          onPinToBoard={handlePinToBoard}
          onReactionPublished={handleReactionPublished}
          onReplyPublished={handleComposePublished}
          autoReplyTo={autoReplyNoteRef.current}
          onOpenEmojiSets={() => setEmojiSetsOpen(true)}
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
                onOpenEmojiSets={() => setEmojiSetsOpen(true)}
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
            <AdvancedSettings
              dismissedCount={dismissedCount}
              onClearDismissed={() => { clearDismissed(); setAdvancedSettingsOpen(false); }}
              onOpenProfileCache={() => { setAdvancedSettingsOpen(false); setProfileCacheSettingsOpen(true); }}
              publishClientTag={appConfig.publishClientTag !== false}
              onToggleClientTag={() => updateConfig(c => ({ ...c, publishClientTag: !(c.publishClientTag !== false) }))}
              publicBookmarks={publicBookmarks}
              onTogglePublicBookmarks={() => { if (publicBookmarks) { setPublicBookmarks(false); setTimeout(republishBookmarks, 500); } else { setPublicBookmarks(true); setTimeout(republishBookmarks, 500); } }}
              onDeleteAccount={() => { setAdvancedSettingsOpen(false); setShowVanishConfirm(true); }}
              initialSection={advancedSection}
              isOnboarding={isOnboarding}
              onResetOnboarding={() => { setOnboardFollowTarget((contacts?.length ?? 0) + 10); setOnboardingSkipped(false); setAdvancedSettingsOpen(false); setActiveTab('discover'); }}
            />
          </DialogContent>
        </Dialog>

        {/* Emoji Sets Dialog */}
        <Dialog open={emojiSetsOpen} onOpenChange={setEmojiSetsOpen}>
          <DialogContent className="sm:max-w-[520px] max-h-[85dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Emoji Sets</DialogTitle>
              <DialogDescription className="sr-only">Manage custom emoji sets for reactions</DialogDescription>
            </DialogHeader>
            <EmojiSetEditor />
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
  );
}

export default MultiColumnClient;