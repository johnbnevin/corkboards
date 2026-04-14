import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { toast } from '@/hooks/useToast'
import { useQuery } from '@tanstack/react-query'
import { useNostr } from '@nostrify/react'
import type { NostrEvent } from '@nostrify/nostrify'
import { useAuthor } from '@/hooks/useAuthor'
import { useNip65Relays } from '@/hooks/useNip65Relays'
import { SmartNoteContent } from '@/components/SmartNoteContent'
import { formatTimeAgoCompact } from '@/lib/formatTimeAgo'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ProfileAbout } from '@/components/ProfileAbout'
import { EmojiName } from '@/components/EmojiName'
import { genUserName } from '@/lib/genUserName'
import { nip19 } from 'nostr-tools'
import {
  Globe,
  Zap,
  CheckCircle2,
  Copy,
  Check,
  ChevronDown,
  Radio,
  ExternalLink,
  X,
  PlusCircle,
  UserPlus,
  Layers,
  VolumeX,
} from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

/** Sanitizes a user-supplied banner URL for safe use in a CSS backgroundImage. */
function sanitizeBannerUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.href.replace(/"/g, '%22');
  } catch { return ''; }
}

// Custom events for profile actions (listened by MultiColumnClient)
export interface ProfileActionDetail {
  pubkey: string
  feedId?: string
}

export const PROFILE_ACTION_NEW_CORKBOARD = 'profile:new-corkboard'
export const PROFILE_ACTION_ADD_TO_CORKBOARD = 'profile:add-to-corkboard'
export const PROFILE_ACTION_FOLLOW = 'profile:follow'
export const PROFILE_ACTION_MUTE = 'profile:mute'

// Global state for custom feeds and contacts (set by MultiColumnClient)
// eslint-disable-next-line react-refresh/only-export-components
export const profileModalState = {
  customFeeds: [] as Array<{ id: string; title: string }>,
  contacts: [] as string[],
}

// Context for managing profile modal state
interface ProfileModalContextType {
  openProfile: (pubkey: string) => void
  closeProfile: () => void
}

const ProfileModalContext = createContext<ProfileModalContextType | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useProfileModal() {
  const context = useContext(ProfileModalContext)
  if (!context) {
    throw new Error('useProfileModal must be used within ProfileModalProvider')
  }
  return context
}

// Provider component
export function ProfileModalProvider({ children }: { children: ReactNode }) {
  const [activePubkey, setActivePubkey] = useState<string | null>(null)
  const [isOpen, setIsOpen] = useState(false)

  const openProfile = useCallback((pubkey: string) => {
    setActivePubkey(pubkey)
    setIsOpen(true)
  }, [])

  const closeTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // Clean up close timer on unmount
  useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current) }, [])

  const closeProfile = useCallback(() => {
    setIsOpen(false)
    // Delay clearing pubkey so animation completes
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(() => setActivePubkey(null), 200)
  }, [])

  return (
    <ProfileModalContext.Provider value={{ openProfile, closeProfile }}>
      {children}
      <ProfileModalDialog
        pubkey={activePubkey}
        isOpen={isOpen}
        onClose={closeProfile}
      />
    </ProfileModalContext.Provider>
  )
}

// The actual modal dialog
interface ProfileModalDialogProps {
  pubkey: string | null
  isOpen: boolean
  onClose: () => void
}

function ProfileModalDialog({ pubkey, isOpen, onClose }: ProfileModalDialogProps) {
  const { data: author, isLoading } = useAuthor(pubkey || '')
  const { nostr } = useNostr()
  const { fetchRelaysForPubkey } = useNip65Relays()
  const [copied, setCopied] = useState(false)
  const [relaysOpen, setRelaysOpen] = useState(false)
  const [relays, setRelays] = useState<string[]>([])
  const [relaysLoading, setRelaysLoading] = useState(false)
  const relaysFetchedRef = useRef(false)
  const relaysFetchAbortRef = useRef<AbortController | null>(null)

  // Lazy-load relays only when the collapsible is first opened
  const handleRelaysOpenChange = useCallback((open: boolean) => {
    setRelaysOpen(open)
    if (open && !relaysFetchedRef.current && pubkey) {
      relaysFetchedRef.current = true
      setRelaysLoading(true)
      relaysFetchAbortRef.current = new AbortController()
      fetchRelaysForPubkey(pubkey, relaysFetchAbortRef.current.signal).then((r) => {
        setRelays(r)
        setRelaysLoading(false)
      })
    }
  }, [pubkey, fetchRelaysForPubkey])

  // Reset relay state when pubkey changes (different profile opened)
  useEffect(() => {
    relaysFetchAbortRef.current?.abort()
    relaysFetchAbortRef.current = null
    setRelays([])
    setRelaysOpen(false)
    setRelaysLoading(false)
    relaysFetchedRef.current = false
  }, [pubkey])

  if (!pubkey) return null

  const metadata = author?.metadata
  const displayName = metadata?.display_name || metadata?.name || genUserName(pubkey)
  const npub = nip19.npubEncode(pubkey)
  const shortNpub = `${npub.slice(0, 16)}...${npub.slice(-8)}`

  const copyNpub = async () => {
    try {
      await navigator.clipboard.writeText(npub)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast({ title: 'Copy failed', description: 'Could not copy to clipboard.', variant: 'destructive' })
    }
  }

  // Parse nip05 for display
  const nip05Display = metadata?.nip05?.startsWith('_@')
    ? metadata.nip05.slice(2)
    : metadata?.nip05

  // Parse website for display
  const websiteDisplay = metadata?.website ? (() => {
    try {
      const url = new URL(metadata.website)
      const fullPath = url.hostname + url.pathname.replace(/\/$/, '')
      return fullPath.length <= 40 ? fullPath : url.hostname
    } catch {
      return metadata.website.length <= 40 ? metadata.website : metadata.website.slice(0, 37) + '...'
    }
  })() : null

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 max-h-[85dvh] overflow-hidden">
        <DialogTitle className="sr-only">User profile</DialogTitle>
        <DialogDescription className="sr-only">View profile details, notes, and social actions</DialogDescription>

        {/* Close button — outside scroll area so it stays visible */}
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-2 right-2 z-10 h-8 w-8 rounded-full bg-black/50 hover:bg-black/70 text-white"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>

        <div className="overflow-y-auto max-h-[85dvh]">
        {/* Banner area */}
        {metadata?.banner && /^https?:\/\//.test(metadata.banner) ? (
          <div className="h-24 w-full bg-cover bg-center" style={{ backgroundImage: `url("${sanitizeBannerUrl(metadata.banner)}")` }} />
        ) : (
          <div className="h-24 w-full bg-gradient-to-r from-purple-500 to-pink-500" />
        )}

        {/* Profile content */}
        <div className="px-4 pb-4">
          {/* Avatar - overlapping banner */}
          <div className="-mt-10 mb-3">
            {isLoading ? (
              <Skeleton className="h-60 w-60 rounded-lg border-4 border-background" />
            ) : (
              <Avatar className="h-60 w-60 border-4 border-background">
                {metadata?.picture && <AvatarImage src={metadata.picture} alt={displayName} />}
                <AvatarFallback className="text-5xl">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
            )}
          </div>

          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-4 w-60" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            <>
              {/* Name and verification */}
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-bold"><EmojiName name={displayName} event={author?.event} /></h2>
                {metadata?.nip05 && (
                  <Badge variant="secondary" className="text-xs gap-1">
                    <CheckCircle2 className="h-3 w-3 text-purple-500" />
                    {nip05Display}
                  </Badge>
                )}
                {metadata?.bot && (
                  <Badge variant="outline" className="text-xs">BOT</Badge>
                )}
              </div>

              {/* npub with copy */}
              <button
                onClick={copyNpub}
                className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mt-1"
              >
                <code className="font-mono text-xs">{shortNpub}</code>
                {copied ? <Check className="h-3 w-3 text-purple-500" /> : <Copy className="h-3 w-3" />}
              </button>

              {/* About */}
              {metadata?.about && (
                <div className="mt-3">
                  <ProfileAbout about={metadata.about} pubkey={pubkey} />
                </div>
              )}

              {/* Links: Website + Lightning */}
              {(metadata?.website || metadata?.lud16) && (
                <div className="flex flex-wrap gap-4 mt-3 text-sm">
                  {metadata?.website && /^https?:\/\//.test(metadata.website) && (
                    <a
                      href={metadata.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 text-muted-foreground hover:text-purple-500"
                    >
                      <Globe className="h-4 w-4" />
                      <span>{websiteDisplay}</span>
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {metadata?.lud16 && (
                    <span className="flex items-center gap-1.5 text-amber-500">
                      <Zap className="h-4 w-4" />
                      <span className="truncate max-w-[200px]">{metadata.lud16}</span>
                    </span>
                  )}
                </div>
              )}

              {/* Relays section - collapsible (lazy-loaded on first open) */}
              <Collapsible open={relaysOpen} onOpenChange={handleRelaysOpenChange} className="mt-4">
                <CollapsibleTrigger asChild>
                  <Button variant="outline" size="sm" className="w-full justify-between">
                    <span className="flex items-center gap-2">
                      <Radio className="h-4 w-4" />
                      Relays
                      {!relaysLoading && (
                        <Badge variant="secondary" className="text-xs">
                          {relays.length}
                        </Badge>
                      )}
                    </span>
                    <ChevronDown className={`h-4 w-4 transition-transform ${relaysOpen ? 'rotate-180' : ''}`} />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 p-3 bg-muted/50 rounded-md max-h-40 overflow-y-auto">
                    {relaysLoading ? (
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-3/4" />
                      </div>
                    ) : relays.length > 0 ? (
                      <div className="space-y-1">
                        {relays.map((relay) => {
                          const host = relay.replace('wss://', '').replace('ws://', '').replace(/\/$/, '')
                          return (
                            <div key={relay} className="text-sm font-mono text-muted-foreground">
                              {host}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">No relays published</p>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>

              {/* Action buttons */}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent(PROFILE_ACTION_NEW_CORKBOARD, { detail: { pubkey } }))
                    onClose()
                  }}
                >
                  <PlusCircle className="h-3.5 w-3.5" />
                  Open in new corkboard
                </Button>

                {profileModalState.customFeeds.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-1.5">
                        <Layers className="h-3.5 w-3.5" />
                        Add to corkboard
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      {profileModalState.customFeeds.map(feed => (
                        <DropdownMenuItem
                          key={feed.id}
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent(PROFILE_ACTION_ADD_TO_CORKBOARD, {
                              detail: { pubkey, feedId: feed.id }
                            }))
                            onClose()
                          }}
                        >
                          {feed.title}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}

                {!profileModalState.contacts.includes(pubkey) && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent(PROFILE_ACTION_FOLLOW, { detail: { pubkey } }))
                      onClose()
                    }}
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    Follow
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-muted-foreground hover:text-red-500 hover:border-red-300"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent(PROFILE_ACTION_MUTE, { detail: { pubkey } }))
                    onClose()
                  }}
                >
                  <VolumeX className="h-3.5 w-3.5" />
                  Mute
                </Button>
              </div>

              {/* Recent notes from this npub */}
              <RecentNotes pubkey={pubkey} nostr={nostr} />
            </>
          )}
        </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Fetch and display the last 5 notes from a pubkey */
function RecentNotes({ pubkey, nostr }: { pubkey: string; nostr: ReturnType<typeof useNostr>['nostr'] }) {
  const { data: notes, isLoading } = useQuery<NostrEvent[]>({
    queryKey: ['profile-recent-notes', pubkey],
    queryFn: async ({ signal }) => {
      const events = await nostr.query(
        [{ kinds: [1], authors: [pubkey], limit: 5 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
      )
      // Filter out replies (only root notes) and sort by date
      return events
        .filter(e => !e.tags.some(t => t[0] === 'e'))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 5)
    },
    staleTime: 2 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <div className="mt-4 space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Recent notes</p>
        <Skeleton className="h-12 w-full rounded" />
        <Skeleton className="h-12 w-full rounded" />
      </div>
    )
  }

  if (!notes || notes.length === 0) return null

  return (
    <div className="mt-4 space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Recent notes</p>
      {notes.map(note => (
        <div key={note.id} className="rounded-lg border bg-muted/30 p-2.5 space-y-1">
          <div className="text-xs text-muted-foreground">{formatTimeAgoCompact(note.created_at)}</div>
          <div className="text-sm line-clamp-3">
            <SmartNoteContent event={note} className="text-sm" />
          </div>
        </div>
      ))}
    </div>
  )
}

// Clickable profile component for avatars and names
interface ClickableProfileProps {
  pubkey: string
  children: ReactNode
  className?: string
}

export function ClickableProfile({ pubkey, children, className }: ClickableProfileProps) {
  const { openProfile } = useProfileModal()

  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        openProfile(pubkey)
      }}
      className={className}
    >
      {children}
    </button>
  )
}
