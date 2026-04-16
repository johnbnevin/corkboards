import { useState, useEffect, memo } from 'react'
import { toast } from '@/hooks/useToast'
import { useAuthor } from '@/hooks/useAuthor'
import { useNip65Relays } from '@/hooks/useNip65Relays'
import { usePlatformStorage } from '@/hooks/usePlatformStorage'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { STORAGE_KEYS } from '@/lib/storageKeys'
import { useIsMobile } from '@/hooks/useIsMobile'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ClickableProfile } from '@/components/ProfileModal'
import { genUserName } from '@/lib/genUserName'
import { optimizeAvatarUrl } from '@/lib/imageUtils'
import { nip19 } from 'nostr-tools'
import {
  Globe,
  Zap,
  CheckCircle2,
  Copy,
  Check,
  ChevronDown,
} from 'lucide-react'

/** Placeholder banner shown on the me tab when user has no banner set */
const BannerPlaceholder = memo(function BannerPlaceholder() {
  return (
    <div className="w-full h-full relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-sky-400 via-sky-300 to-sky-200 dark:from-sky-700 dark:via-sky-600 dark:to-sky-500" />
      <div className="absolute top-3 left-[15%] w-16 h-5 bg-white/40 dark:bg-white/20 rounded-full blur-sm" />
      <div className="absolute top-5 left-[60%] w-12 h-4 bg-white/30 dark:bg-white/15 rounded-full blur-sm" />
      <svg className="absolute bottom-0 w-full" viewBox="0 0 400 80" preserveAspectRatio="none" style={{ height: '50%' }}>
        <ellipse cx="100" cy="80" rx="180" ry="60" className="fill-green-400 dark:fill-green-700" />
        <ellipse cx="320" cy="80" rx="160" ry="50" className="fill-green-500 dark:fill-green-800" />
        <ellipse cx="200" cy="80" rx="220" ry="40" className="fill-green-600 dark:fill-green-900" />
      </svg>
    </div>
  )
})

/** Placeholder avatar shown on the me tab when user has no picture set */
const AvatarPlaceholder = memo(function AvatarPlaceholder() {
  return (
    <div className="w-full h-full bg-gradient-to-b from-gray-300 to-gray-400 dark:from-gray-600 dark:to-gray-700 flex items-center justify-center">
      <svg viewBox="0 0 100 100" className="w-3/4 h-3/4 opacity-40">
        <circle cx="50" cy="35" r="18" fill="currentColor" />
        <ellipse cx="50" cy="85" rx="30" ry="22" fill="currentColor" />
      </svg>
    </div>
  )
})

import { FeedFilters } from '@/components/FeedFilters'
import type { KindFilter, NoteKindStats, ContentFilterConfig, ContentFilterKey } from '@/components/FeedFilters'

interface ProfileCardProps {
  pubkey: string
  className?: string
  compact?: boolean
  stats?: {
    follows?: number
    notes?: number
    noteKinds?: NoteKindStats
  }
  hashtags?: { tag: string; count: number }[]
  onLoadMore?: (hours: number) => void
  isLoadingMore?: boolean
  hoursLoaded?: number
  multiplier?: number
  hasMore?: boolean
  showOwnNotes?: boolean
  onToggleOwnNotes?: () => void
  showPinned?: boolean
  onToggleShowPinned?: () => void
  showUnpinned?: boolean
  onToggleShowUnpinned?: () => void
  onFilterByKind?: (kind: KindFilter | 'all' | 'none') => void
  onFilterByHashtag?: (hashtag: string) => void
  filterMode?: 'any' | 'strict'
  onToggleFilterMode?: () => void
  kindFilters?: Set<KindFilter>
  hashtagFilters?: Set<string>
  onClearFilters?: () => void
  contentFilterConfig?: ContentFilterConfig
  onContentFilterChange?: (key: ContentFilterKey, value: number | boolean | string) => void
  hasActiveContentFilters?: boolean
  dismissedCount?: number
  visibleNotesCount?: number
  /** When true, show placeholder banner/avatar when user has no image set (used on the me tab) */
  showPlaceholders?: boolean
  /** Callback to open the edit profile modal (renders a green button in the top-left corner) */
  onEditProfile?: () => void
}

export function ProfileCard({
  pubkey,
  className,
  compact = false,
  stats,
  hashtags,
  hoursLoaded,
  multiplier,
  showOwnNotes,
  onToggleOwnNotes,
  showPinned,
  onToggleShowPinned,
  showUnpinned,
  onToggleShowUnpinned,
  onFilterByKind,
  onFilterByHashtag,
  filterMode,
  onToggleFilterMode,
  kindFilters,
  hashtagFilters,
  onClearFilters,
  contentFilterConfig,
  onContentFilterChange,
  hasActiveContentFilters,
  dismissedCount,
  visibleNotesCount,
  showPlaceholders = false,
  onEditProfile,
}: ProfileCardProps) {
  const hasActiveFilters = (kindFilters?.size ?? 0) > 0 || (hashtagFilters?.size ?? 0) > 0 || !!hasActiveContentFilters
  const { data: author, isLoading } = useAuthor(pubkey)
  const { fetchRelaysForPubkey } = useNip65Relays()
  const isMobile = useIsMobile()
  const [copied, setCopied] = useState(false)
  const [relaysOpen, setRelaysOpen] = useState(false)
  const [relays, setRelays] = useState<string[]>([])
  const [relaysLoading, setRelaysLoading] = useState(true)
  const [isProfileCollapsed, setIsProfileCollapsed] = usePlatformStorage<boolean>(STORAGE_KEYS.PROFILE_CARD_COLLAPSED, isMobile)
  const [filtersOpen, setFiltersOpen] = useState(!isMobile)
  const [bannerHeightPct] = useLocalStorage<number>(STORAGE_KEYS.BANNER_HEIGHT_PCT, 0)
  const [bannerFitMode] = useLocalStorage<string>(STORAGE_KEYS.BANNER_FIT_MODE, 'crop')
  const [naturalBannerPct, setNaturalBannerPct] = useState(0)
  const effectiveBannerPct = bannerHeightPct === 0 ? naturalBannerPct : bannerHeightPct

  useEffect(() => {
    let cancelled = false
    setRelaysLoading(true)
    fetchRelaysForPubkey(pubkey).then((r) => {
      if (!cancelled) {
        setRelays(r)
        setRelaysLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [pubkey, fetchRelaysForPubkey])

  const metadata = author?.metadata
  const displayName = metadata?.display_name || metadata?.name || genUserName(pubkey)
  const npub = nip19.npubEncode(pubkey)
  const shortNpub = `${npub.slice(0, 12)}...${npub.slice(-8)}`

  const copyNpub = async () => {
    try {
      await navigator.clipboard.writeText(npub)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast({ title: 'Copy failed', description: 'Could not copy to clipboard.', variant: 'destructive' })
    }
  }

  const nip05Display = metadata?.nip05?.startsWith('_@')
    ? metadata.nip05.slice(2)
    : metadata?.nip05

  const websiteDisplay = metadata?.website ? (() => {
    try {
      const url = new URL(metadata.website)
      const fullPath = url.hostname + url.pathname.replace(/\/$/, '')
      return fullPath.length <= 30 ? fullPath : fullPath.slice(0, 27) + '...'
    } catch {
      return metadata.website.length <= 30 ? metadata.website : metadata.website.slice(0, 27) + '...'
    }
  })() : null

  const lightningDisplay = metadata?.lud16
    ? metadata.lud16.length <= 30 ? metadata.lud16 : metadata.lud16.slice(0, 27) + '...'
    : null

  // Build FeedFilters props (only when filter callbacks are provided).
  // Defined before the loading check so filters show even while profile loads.
  const feedFiltersElement = onFilterByKind && contentFilterConfig && onContentFilterChange ? (
    <div className="mt-2">
    <FeedFilters
      collapsed={!filtersOpen}
      onToggleCollapsed={() => setFiltersOpen(!filtersOpen)}
      showOwnNotes={showOwnNotes}
      onToggleOwnNotes={onToggleOwnNotes}
      showPinned={showPinned}
      onToggleShowPinned={onToggleShowPinned}
      showUnpinned={showUnpinned}
      onToggleShowUnpinned={onToggleShowUnpinned}
      kindFilters={kindFilters ?? new Set()}
      onFilterByKind={onFilterByKind}
      filterMode={filterMode ?? 'any'}
      onToggleFilterMode={onToggleFilterMode ?? (() => {})}
      stats={stats?.noteKinds}
      hashtagFilters={hashtagFilters ?? new Set()}
      onFilterByHashtag={onFilterByHashtag ?? (() => {})}
      hashtags={hashtags ?? []}
      contentFilterConfig={contentFilterConfig}
      onContentFilterChange={onContentFilterChange}
      hasActiveContentFilters={hasActiveContentFilters ?? false}
      hasActiveFilters={hasActiveFilters}
      onClearFilters={onClearFilters ?? (() => {})}
    />
    </div>
  ) : null

  if (isLoading) {
    return (
      <>
        <Card className={className}>
          <CardContent className="p-0">
            <Skeleton className="h-24 sm:h-48 w-full rounded-t-lg" />
            <div className="p-4 flex items-start gap-3 -mt-16">
              <Skeleton className="h-24 w-24 sm:h-48 sm:w-48 rounded-lg border-2 sm:border-4 border-background" />
              <div className="flex-1 space-y-2 mt-12">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-48" />
              </div>
            </div>
          </CardContent>
        </Card>
        {feedFiltersElement}
      </>
    )
  }

  // Collapsed view
  if (isProfileCollapsed) {
    return (
      <>
        <Card className={`relative ${className}`}>
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50 transition-colors rounded-lg"
            onClick={() => setIsProfileCollapsed(false)}
            title="Expand profile"
          >
            <Avatar className="h-6 w-6">
              {metadata?.picture && <AvatarImage src={optimizeAvatarUrl(metadata.picture) || ''} alt={displayName} />}
              <AvatarFallback className="text-[10px]">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="text-xs text-muted-foreground truncate flex-1 text-left">{displayName}</span>
            <span className="text-xs text-muted-foreground shrink-0">Profile</span>
          </button>
          <div className="absolute bottom-0 right-0">
            <button
              onClick={() => setIsProfileCollapsed(false)}
              className="w-0 h-0 border-l-[24px] border-l-transparent border-b-[24px] border-b-green-600/70 hover:border-b-green-500/70 transition-colors"
              title="Show profile"
            />
          </div>
        </Card>
        {feedFiltersElement}
      </>
    )
  }

  return (
    <>
      {/* Profile card — banner, avatar, full info */}
      <Card className={`relative overflow-hidden ${className} ${isMobile ? 'max-h-[70vh] overflow-y-auto' : ''}`}>
        {onEditProfile && (
          <button
            onClick={onEditProfile}
            className="absolute top-0 left-0 z-10 w-0 h-0 border-r-[24px] border-r-transparent border-t-[24px] border-t-green-600/70 hover:border-t-green-500/70 transition-colors"
            title="Customize Profile"
          />
        )}
        {metadata?.banner ? (
          effectiveBannerPct > 0 ? (
            <div className="w-full relative" style={{ paddingBottom: `${effectiveBannerPct}%` }}>
              <img
                src={metadata.banner} alt=""
                className={`absolute inset-0 w-full h-full ${bannerFitMode === 'crop' ? 'object-cover' : 'object-contain'}`}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth > 0 && naturalBannerPct === 0)
                    setNaturalBannerPct(Math.round((img.naturalHeight / img.naturalWidth) * 100));
                }}
              />
            </div>
          ) : (
            <div className="w-full">
              <img
                src={metadata.banner} alt="" className="w-full h-auto"
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth > 0 && naturalBannerPct === 0)
                    setNaturalBannerPct(Math.round((img.naturalHeight / img.naturalWidth) * 100));
                }}
              />
            </div>
          )
        ) : showPlaceholders ? (
          <div className="h-28 sm:h-36 w-full"><BannerPlaceholder /></div>
        ) : (
          <div className="h-28 sm:h-36 w-full bg-gradient-to-r from-purple-500/20 via-pink-500/20 to-indigo-500/20" />
        )}

        <CardContent className={compact ? "p-3 pt-1" : "p-4 pt-1"}>
          <div className="flex items-start gap-3">
            <ClickableProfile pubkey={pubkey} className="hover:opacity-80 transition-opacity shrink-0 -mt-16 sm:-mt-36 md:-mt-44">
              <Avatar className="h-24 w-24 sm:h-48 sm:w-48 md:h-56 md:w-56 border-2 sm:border-4 border-background shadow-lg">
                {metadata?.picture && <AvatarImage src={optimizeAvatarUrl(metadata.picture) || ''} alt={displayName} />}
                <AvatarFallback className="text-2xl p-0">
                  {showPlaceholders && !metadata?.picture
                    ? <AvatarPlaceholder />
                    : displayName.slice(0, 2).toUpperCase()
                  }
                </AvatarFallback>
              </Avatar>
            </ClickableProfile>
            <div className="flex-1 min-w-0 pt-1">
              <div className="flex items-center gap-2 flex-wrap">
                <ClickableProfile pubkey={pubkey} className="hover:opacity-80 transition-opacity">
                  <h3 className="font-bold text-lg truncate">{displayName}</h3>
                </ClickableProfile>
                {metadata?.bot && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">BOT</Badge>
                )}
              </div>
              {metadata?.nip05 && (
                <div className="flex items-center gap-1 mt-0.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-purple-500" />
                  <span className="text-xs text-purple-600 dark:text-purple-400 truncate">{nip05Display}</span>
                </div>
              )}
            </div>
          </div>

          {metadata?.about && !compact && (
            <p className="text-sm text-muted-foreground mb-3 leading-relaxed whitespace-pre-wrap line-clamp-4">
              {metadata.about}
            </p>
          )}

          <div className="flex items-center gap-3 flex-wrap text-xs">
            <button
              onClick={copyNpub}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <code className="font-mono text-[10px]">{shortNpub}</code>
              {copied ? <Check className="h-3 w-3 text-purple-500" /> : <Copy className="h-3 w-3" />}
            </button>
            {stats?.follows !== undefined && (
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">{stats.follows}</span> following
              </span>
            )}
            {metadata?.website && (
              <a
                href={metadata.website}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-muted-foreground hover:text-purple-500"
              >
                <Globe className="h-3 w-3" />
                <span>{websiteDisplay}</span>
              </a>
            )}
            {lightningDisplay && (
              <span className="flex items-center gap-1 text-amber-500">
                <Zap className="h-3 w-3" />
                <span>{lightningDisplay}</span>
              </span>
            )}
          </div>

          {/* Relays */}
          <div className="mt-3">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs gap-1"
              onClick={() => setRelaysOpen(!relaysOpen)}
            >
              <ChevronDown className={`h-3 w-3 transition-transform ${relaysOpen ? '' : '-rotate-90'}`} />
              Relays
              {!relaysLoading && (
                <Badge variant="secondary" className="text-xs px-1 py-0 h-4">{relays.length}</Badge>
              )}
            </Button>
            {relaysOpen && (
              <div className="mt-1 p-2 bg-muted/50 rounded-md max-h-32 overflow-y-auto">
                {relaysLoading ? (
                  <div className="space-y-1">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                  </div>
                ) : relays.length > 0 ? (
                  <div className="space-y-0.5">
                    {relays.map((relay, i) => (
                      <div key={i} className="text-xs font-mono text-muted-foreground truncate">
                        {relay.replace('wss://', '').replace('ws://', '').replace(/\/$/, '')}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground italic">No relays published</p>
                )}
              </div>
            )}
          </div>

          {/* Notes loaded */}
          {stats?.noteKinds && (
            <div className="mt-3 pt-2 border-t flex items-center gap-2 text-xs text-muted-foreground">
              {(!stats.noteKinds.total || stats.noteKinds.total === 0) ? (
                <span className="text-orange-600 dark:text-orange-400">No notes in past {hoursLoaded || multiplier || 1} hour{(hoursLoaded || multiplier || 1) > 1 ? 's' : ''}. Click Load more below.</span>
              ) : (visibleNotesCount !== undefined && visibleNotesCount === 0 && (dismissedCount ?? 0) > 0) ? (
                <span className="text-orange-600 dark:text-orange-400">All {stats.noteKinds.total} notes are dismissed ({dismissedCount} total dismissed). Use gear → Bring back to restore.</span>
              ) : (
                <span><span className="font-medium text-foreground">{visibleNotesCount !== undefined ? visibleNotesCount : stats.noteKinds.total}</span> notes showing{visibleNotesCount !== undefined && visibleNotesCount < stats.noteKinds.total ? ` (${stats.noteKinds.total} loaded)` : ''}</span>
              )}
            </div>
          )}
        </CardContent>

        <div className="absolute top-0 right-0 z-10">
          <button
            onClick={() => setIsProfileCollapsed(true)}
            className="w-0 h-0 border-l-[24px] border-l-transparent border-t-[24px] border-t-red-600/70 hover:border-t-red-500/70 transition-colors"
            title="Collapse profile"
          />
        </div>
      </Card>

      {/* Filter card */}
      {feedFiltersElement}
    </>
  )
}
