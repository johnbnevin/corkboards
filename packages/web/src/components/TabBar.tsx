/**
 * TabBar — the navigation strip at the top of the main feed area.
 *
 * • Mobile: a horizontally-scrollable row of rounded pill buttons.
 * • Desktop: a shadcn <Tabs> / <TabsList> with drag-and-drop reordering,
 *   plus the resizable "New Corkboard" dialog triggered from within the list.
 *
 * Extracted from MultiColumnClient.tsx to keep that file manageable.
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useIsMobile } from '@/hooks/useIsMobile';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ResizableDialog, ResizableDialogContent } from '@/components/ui/resizable-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  PlusIcon, UserIcon, Layers, Radio, Rss, Compass, Users, Save, Bell,
  ChevronLeft, ChevronRight, HelpCircle, Pencil, Trash2, MoreVertical,
} from 'lucide-react';
import { genUserName } from '@/lib/genUserName';
import { optimizeAvatarUrl } from '@/lib/imageUtils';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CustomFeedDef {
  id: string;
  title: string;
  pubkeys: string[];
  relays: string[];
  rssUrls: string[];
}

interface TabBarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  isPending?: boolean;
  userPubkey: string | undefined;
  collapsedCount: number;
  newNotificationCount?: number;

  customFeeds: CustomFeedDef[];
  setCustomFeeds: (updater: CustomFeedDef[] | ((prev: CustomFeedDef[]) => CustomFeedDef[])) => void;

  browseRelays: string[];
  setBrowseRelays: (updater: string[] | ((prev: string[]) => string[])) => void;

  rssFeeds: string[];
  setRssFeeds: (updater: string[] | ((prev: string[]) => string[])) => void;

  /** Profile data for friend avatars / names */
  availableFollows: { pubkey: string; name: string; picture?: string }[];
  followsData: { pubkey: string; name: string; picture?: string }[] | undefined;
  allFollowsData: { pubkey: string; name: string; picture?: string }[];

  /** Follows list pagination */
  contacts: string[] | undefined;
  isLoadingFollows: boolean;
  followsOffset: number;
  hasMoreFollows: boolean;
  isLoadingMoreFollows: boolean;
  onLoadMoreFollows: () => void;

  /** Feed-builder dialog state — lifted to MultiColumnClient so it can be
   *  opened from other places (e.g. ProfileModal actions) */
  showAddFriendDialog: boolean;
  setShowAddFriendDialog: (open: boolean) => void;
  editingFeedId: string | null;
  setEditingFeedId: (id: string | null) => void;
  feedTitle: string;
  setFeedTitle: (t: string) => void;
  feedPubkeys: Set<string>;
  setFeedPubkeys: (s: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  feedRelays: string;
  setFeedRelays: (r: string) => void;
  feedRssUrls: Set<string>;
  setFeedRssUrls: (s: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  feedHashtags: Set<string>;
  setFeedHashtags: (s: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  newFriendInput: string;
  setNewFriendInput: (v: string) => void;
  addFeedSource: (raw: string) => boolean;
  parseFeedSource: (raw: string) => { type: 'relay' | 'rss' | 'pubkey' | 'hashtag'; value: string } | null;

  onCreateOrUpdateFeed: () => void;

  /** Toast notification (for validation errors in the dialog) */
  showToast: (opts: { title: string; variant?: 'destructive' }) => void;

  /** NIP-51 follow sets (kind 30000) */
  followSets?: { name: string; dTag: string; pubkeys: string[] }[];
  isLoadingFollowSets?: boolean;

  /** When true, user is onboarding (< 10 follows) — hide all tabs except Discover */
  isOnboarding?: boolean;

  /** Edit a custom feed — loads it into the dialog */
  onEditFeed?: (feedId: string) => void;
  /** Delete a custom feed */
  onDeleteFeed?: (feedId: string) => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function TabBar({
  activeTab,
  setActiveTab,
  isPending = false,
  userPubkey,
  collapsedCount,
  newNotificationCount = 0,
  customFeeds,
  setCustomFeeds,
  browseRelays,
  setBrowseRelays,
  rssFeeds,
  setRssFeeds,
  availableFollows: _availableFollows,
  followsData: _followsData,
  allFollowsData,
  contacts,
  isLoadingFollows,
  followsOffset,
  hasMoreFollows,
  isLoadingMoreFollows,
  onLoadMoreFollows,
  showAddFriendDialog,
  setShowAddFriendDialog,
  editingFeedId,
  setEditingFeedId,
  feedTitle,
  setFeedTitle,
  feedPubkeys,
  setFeedPubkeys,
  feedRelays,
  setFeedRelays,
  feedRssUrls,
  setFeedRssUrls,
  feedHashtags,
  setFeedHashtags,
  newFriendInput,
  setNewFriendInput,
  addFeedSource,
  parseFeedSource: _parseFeedSource,
  onCreateOrUpdateFeed,
  showToast: _showToast,
  followSets = [],
  isLoadingFollowSets = false,
  isOnboarding = false,
  onEditFeed,
  onDeleteFeed,
}: TabBarProps) {
  const isMobile = useIsMobile();
  const [sourcesHelpOpen, setSourcesHelpOpen] = useState(false);

  // Shared "New Corkboard" dialog content — used in both mobile and desktop
  const newCorkboardDialog = (
    <ResizableDialog
      open={showAddFriendDialog}
      onOpenChange={(open) => {
        setShowAddFriendDialog(open);
        if (!open) {
          setFeedTitle('');
          setFeedPubkeys(new Set());
          setFeedRelays('');
          setFeedRssUrls(new Set());
          setEditingFeedId(null);
        }
      }}
    >
      {/* On mobile the trigger is a separate button; on desktop it's wired below */}
      <ResizableDialogContent
        defaultWidth={600}
        defaultHeight={700}
        minWidth={400}
        minHeight={350}
        dialogTitle={editingFeedId ? 'Edit Corkboard' : 'New Corkboard'}
        dialogDescription="Configure corkboard sources and filters"
      >
        <div className="w-full h-full flex flex-col">
          <div className="flex-1 overflow-y-auto mt-0">
            <div className="space-y-4 py-4 px-1">
              {/* Feed Title */}
              <div className="space-y-2">
                <h3 className="font-medium flex items-center gap-2">
                  <Layers className="h-4 w-4 text-purple-500" />
                  Corkboard Name
                </h3>
                <Input
                  value={feedTitle}
                  onChange={(e) => setFeedTitle(e.target.value)}
                  placeholder="e.g., 'Bitcoin News', 'Tech Friends', 'Daily Read'"
                />
              </div>

              <Separator />

              {/* Sources Section */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium">Sources</h3>
                  <button type="button" onClick={() => setSourcesHelpOpen(true)} className="text-muted-foreground hover:text-foreground transition-colors"><HelpCircle className="h-3.5 w-3.5" /></button>
                </div>

                {/* Add by URL */}
                <div className="space-y-2">
                  <div className="flex space-x-2">
                    <Input
                      value={newFriendInput}
                      onChange={(e) => setNewFriendInput(e.target.value)}
                      placeholder="npub, #hashtag, relay, or RSS feed URL (.rss, /feed, .xml)"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addFeedSource(newFriendInput);
                        }
                      }}
                    />
                    <Button variant="outline" onClick={() => addFeedSource(newFriendInput)}>
                      Add
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Nostr npubs, #hashtags, relay URLs, or RSS feed URLs (comma-separated).
                  </p>
                </div>

                {/* Selected Sources Display */}
                {(feedPubkeys.size > 0 || feedRelays || feedRssUrls.size > 0 || feedHashtags.size > 0) && (
                  <div className="flex flex-wrap gap-1">
                    {Array.from(feedPubkeys).map(pubkey => {
                      const profile = allFollowsData.find(f => f.pubkey === pubkey);
                      return (
                        <Badge key={pubkey} variant="secondary" className="gap-1 pr-1">
                          <UserIcon className="h-3 w-3" />
                          {profile?.name || genUserName(pubkey)}
                          <button type="button" className="ml-1 hover:text-red-500" onClick={() => setFeedPubkeys(prev => { const s = new Set(prev); s.delete(pubkey); return s; })}>×</button>
                        </Badge>
                      );
                    })}
                    {feedRelays && feedRelays.split(',').filter(r => r.trim()).map(relay => (
                      <Badge key={relay.trim()} variant="secondary" className="gap-1 pr-1">
                        <Radio className="h-3 w-3 text-purple-500" />
                        {relay.trim().replace('wss://', '').split('/')[0]}
                        <button type="button" className="ml-1 hover:text-red-500" onClick={() => { const relays = feedRelays.split(',').map(r => r.trim()).filter(r => r !== relay.trim()); setFeedRelays(relays.join(', ')); }}>×</button>
                      </Badge>
                    ))}
                    {Array.from(feedRssUrls).map(url => (
                      <Badge key={url} variant="secondary" className="gap-1 pr-1">
                        <Rss className="h-3 w-3 text-orange-500" />
                        {(() => { try { return new URL(url).hostname.replace('www.', '').split('.')[0]; } catch { return url.slice(0, 30); } })()}
                        <button type="button" className="ml-1 hover:text-red-500" onClick={() => setFeedRssUrls(prev => { const s = new Set(prev); s.delete(url); return s; })}>×</button>
                      </Badge>
                    ))}
                    {Array.from(feedHashtags).map(tag => (
                      <Badge key={tag} variant="secondary" className="gap-1 pr-1 text-blue-600 dark:text-blue-400">
                        #{tag}
                        <button type="button" className="ml-1 hover:text-red-500" onClick={() => setFeedHashtags(prev => { const s = new Set(prev); s.delete(tag); return s; })}>×</button>
                      </Badge>
                    ))}
                  </div>
                )}

                {/* Quick-fill from NIP-51 follow sets (kind 30000) */}
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Quick-fill from your Nostr lists:</p>
                  {isLoadingFollowSets ? (
                    <Skeleton className="h-7 w-40" />
                  ) : followSets.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {followSets.map(list => (
                        <Button
                          key={list.dTag}
                          variant="outline"
                          size="sm"
                          className="text-xs gap-1"
                          onClick={() => {
                            setFeedPubkeys(prev => {
                              const next = new Set(prev);
                              for (const pk of list.pubkeys) next.add(pk);
                              return next;
                            });
                          }}
                        >
                          <Users className="h-3 w-3" />
                          {list.name} ({list.pubkeys.length})
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground/60 italic">No lists found — create people lists in any Nostr client to use them here</p>
                  )}
                </div>

                {/* Select from follows */}
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Or select from your follows:</p>
                  {isLoadingFollows && allFollowsData.length === 0 ? (
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-3/4" />
                    </div>
                  ) : allFollowsData.length > 0 ? (
                    <ScrollArea
                      className="rounded-md border p-3"
                      style={{ resize: 'vertical', minHeight: '120px', height: '200px', maxHeight: '60vh', overflow: 'auto' }}
                    >
                      <div className="space-y-1">
                        {allFollowsData.map((follow) => (
                          <div key={follow.pubkey} className="flex items-center space-x-2">
                            <Checkbox
                              checked={feedPubkeys.has(follow.pubkey)}
                              onCheckedChange={(checked) => {
                                const s = new Set(feedPubkeys);
                                if (checked) s.add(follow.pubkey);
                                else s.delete(follow.pubkey);
                                setFeedPubkeys(s);
                              }}
                            />
                            <Avatar className="h-5 w-5">
                              {follow.picture && <AvatarImage src={optimizeAvatarUrl(follow.picture) || ''} />}
                              <AvatarFallback className="text-xs">{follow.name?.charAt(0) || '?'}</AvatarFallback>
                            </Avatar>
                            <span className="text-sm">{follow.name || genUserName(follow.pubkey)}</span>
                          </div>
                        ))}
                      </div>
                      {hasMoreFollows && contacts && followsOffset + 100 < contacts.length && (
                        <div className="flex justify-center pt-2">
                          <Button variant="ghost" size="sm" onClick={onLoadMoreFollows} disabled={isLoadingMoreFollows}>
                            {isLoadingMoreFollows ? 'Loading...' : 'Load more...'}
                          </Button>
                        </div>
                      )}
                    </ScrollArea>
                  ) : (
                    <p className="text-sm text-gray-500">No follows found.</p>
                  )}
                </div>
              </div>

              <Separator />

              {/* Create / Save Button */}
              <div className="flex gap-2">
                <Button className="flex-1" onClick={onCreateOrUpdateFeed}>
                  <Layers className="h-4 w-4 mr-2" />
                  {editingFeedId ? 'Save Changes' : 'Create Corkboard'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </ResizableDialogContent>
    </ResizableDialog>
  );

  // ── Mobile pill strip ──────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <div>
          {/* Tab switch loading indicator */}
          {isPending && (
            <div className="flex items-center justify-center py-1 mb-1">
              <div className="animate-spin h-3 w-3 border-2 border-purple-500 border-t-transparent rounded-full mr-2" />
              <span className="text-xs text-muted-foreground">Loading...</span>
            </div>
          )}
          <MobileScrollContainer>
            <div className="flex items-center gap-1.5 pb-1 min-w-max">
              {/* Built-in tabs */}
              {!isOnboarding && (
                <MobilePill active={activeTab === 'me'} onClick={() => setActiveTab('me')}>
                  <UserIcon className="h-3.5 w-3.5" />
                  Me
                </MobilePill>
              )}
              {!isOnboarding && userPubkey && (
                <MobilePill active={activeTab === 'notifications'} onClick={() => setActiveTab('notifications')}>
                  <span className="relative">
                    <Bell className="h-3.5 w-3.5" />
                    {newNotificationCount > 0 && (
                      <span className="absolute -top-1 -right-1.5 min-w-[12px] h-[12px] rounded-full bg-red-500 text-white text-[8px] font-bold flex items-center justify-center px-0.5 leading-none">
                        {newNotificationCount}
                      </span>
                    )}
                  </span>
                  Notifications
                </MobilePill>
              )}
              {!isOnboarding && (userPubkey || activeTab === 'all-follows' || activeTab === 'discover') && (
                <MobilePill active={activeTab === 'all-follows'} onClick={() => setActiveTab('all-follows')}>
                  <Users className="h-3.5 w-3.5" />
                  Follows
                </MobilePill>
              )}
              {(userPubkey || activeTab === 'discover') && (
                <MobilePill active={activeTab === 'discover'} onClick={() => setActiveTab('discover')} accent="amber">
                  <Compass className="h-3.5 w-3.5" />
                  Discover
                </MobilePill>
              )}
              {!isOnboarding && (
                <>
                  <MobilePill active={activeTab === 'saved'} onClick={() => setActiveTab('saved')} accent="green">
                    <Save className="h-3.5 w-3.5" />
                    Saved
                    {collapsedCount > 0 && (
                      <span className={`ml-0.5 text-[10px] font-semibold ${
                        activeTab === 'saved' ? 'text-white' : 'text-muted-foreground'
                      }`}>
                        {collapsedCount}
                      </span>
                    )}
                  </MobilePill>

                  {(customFeeds.length > 0 || browseRelays.length > 0 || rssFeeds.length > 0) && (
                    <span className="text-muted-foreground/40 text-xs px-0.5 shrink-0">|</span>
                  )}

                  {customFeeds.map((feed) => {
                    const isActive = activeTab === `feed:${feed.id}`;
                    return (
                      <div key={`feed:${feed.id}`} className="inline-flex items-center shrink-0">
                        <MobilePill active={isActive} onClick={() => setActiveTab(`feed:${feed.id}`)}>
                          <Layers className="h-3.5 w-3.5" />
                          {feed.title}
                        </MobilePill>
                        {isActive && (onEditFeed || onDeleteFeed) && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button type="button" className="h-5 w-4 -ml-0.5 flex items-center justify-center text-purple-300 hover:text-white rounded-r-md bg-purple-600 border border-purple-600 shrink-0">
                                <MoreVertical className="h-3 w-3" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="min-w-[120px]">
                              {onEditFeed && <DropdownMenuItem onClick={() => onEditFeed(feed.id)} className="gap-2 text-xs"><Pencil className="h-3 w-3" />Edit</DropdownMenuItem>}
                              {onDeleteFeed && <DropdownMenuItem onClick={() => onDeleteFeed(feed.id)} className="gap-2 text-xs text-red-600"><Trash2 className="h-3 w-3" />Delete</DropdownMenuItem>}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    );
                  })}

                  {browseRelays.map((relayUrl) => (
                    <MobilePill key={relayUrl} active={activeTab === relayUrl} onClick={() => setActiveTab(relayUrl)}>
                      <Radio className="h-3.5 w-3.5" />
                      {relayUrl.replace('wss://', '').replace('ws://', '').split('/')[0]}
                    </MobilePill>
                  ))}

                  {rssFeeds.map((feedUrl) => {
                    const shortName = (() => { try { return new URL(feedUrl).hostname.replace('www.', '').split('.')[0]; } catch { return 'RSS'; } })();
                    return (
                      <MobilePill key={`rss:${feedUrl}`} active={activeTab === `rss:${feedUrl}`} onClick={() => setActiveTab(`rss:${feedUrl}`)} accent="orange">
                        <Rss className="h-3.5 w-3.5" />
                        {shortName}
                      </MobilePill>
                    );
                  })}

                  {/* New corkboard button */}
                  <button
                    onClick={() => setShowAddFriendDialog(true)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border border-dashed border-muted-foreground/30 text-muted-foreground hover:border-purple-400 hover:text-purple-500 transition-colors shrink-0"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    New
                  </button>
                </>
              )}
            </div>
          </MobileScrollContainer>
        </div>
        {newCorkboardDialog}
        {/* Sources help dialog (shared with desktop) */}
        <Dialog open={sourcesHelpOpen} onOpenChange={setSourcesHelpOpen}>
          <DialogContent className="max-w-[95vw] sm:max-w-[450px] max-h-[85vh] overflow-y-auto" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Adding Sources to a Corkboard</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 text-sm text-muted-foreground">
              <p>A corkboard collects posts from multiple sources into one feed. You can add any combination of:</p>
              <div className="space-y-3">
                <div>
                  <p className="font-medium text-foreground">Nostr users</p>
                  <p className="text-xs">Paste an npub or nprofile address. Separate multiple npubs with commas. You can also select from your follows list below the input.</p>
                </div>
                <div>
                  <p className="font-medium text-foreground">Hashtags</p>
                  <p className="text-xs">Type <code className="bg-muted px-1 rounded">#bitcoin</code> or <code className="bg-muted px-1 rounded">#nostr</code> to follow all notes with that hashtag. Separate multiple with commas. Works great for building topic-based corkboards.</p>
                </div>
                <div>
                  <p className="font-medium text-foreground">RSS feeds</p>
                  <p className="text-xs">Paste any RSS or Atom feed URL. Separate multiple feeds with commas. Most blogs, podcasts, and news sites have an RSS feed — look for the orange RSS icon or try adding <code className="bg-muted px-1 rounded">/feed</code> or <code className="bg-muted px-1 rounded">/rss</code> to the site URL.</p>
                </div>
                <div>
                  <p className="font-medium text-foreground">Nostr relays</p>
                  <p className="text-xs">Paste a relay URL starting with <code className="bg-muted px-1 rounded">wss://</code> to browse all notes from that relay.</p>
                </div>
              </div>
              <div className="rounded-lg bg-muted/50 border p-3 space-y-1.5">
                <p className="font-medium text-foreground text-xs">What about Twitter, Facebook, Instagram, TikTok?</p>
                <p className="text-xs">These platforms deliberately block RSS feeds, scrape access, and charge for API access. They want your content locked inside their walled gardens where they control who sees what and when.</p>
                <p className="text-xs">That's exactly why Nostr exists — and why Corkboards is built on it. On Nostr, no one can lock you out of your own feed, paywall your followers, or decide your content isn't worth showing. Your posts, your keys, your network.</p>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </Tabs>
    );
  }

  // ── Desktop tab bar ────────────────────────────────────────────────────────
  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
      <div className="relative">
        {isPending && (
          <div className="absolute right-0 top-0 bottom-0 flex items-center z-10 pr-1">
            <div className="animate-spin h-3 w-3 border-2 border-purple-500 border-t-transparent rounded-full" />
          </div>
        )}
        <ScrollArea className="w-full whitespace-nowrap">
          <TabsList className="flex space-x-1 p-0 h-auto bg-transparent">
            {!isOnboarding && (
              <TabsTrigger value="me" className="flex items-center gap-1 h-5 px-2 text-xs border border-gray-300 text-gray-700 rounded-md data-[state=active]:bg-purple-600 data-[state=active]:text-white data-[state=active]:border-purple-600">
                <UserIcon className="h-3 w-3" />
                <span>Me</span>
              </TabsTrigger>
            )}
            {!isOnboarding && userPubkey && (
              <TabsTrigger value="notifications" className="flex items-center gap-1 h-5 px-2 text-xs border border-gray-300 text-gray-700 rounded-md data-[state=active]:bg-purple-600 data-[state=active]:text-white data-[state=active]:border-purple-600">
                <Bell className="h-3 w-3 text-purple-500" />
                <span>Notifications</span>
                {newNotificationCount > 0 && (
                  <span className="ml-0.5 min-w-[14px] h-[14px] rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center px-0.5 leading-none">
                    {newNotificationCount}
                  </span>
                )}
              </TabsTrigger>
            )}
            {!isOnboarding && (userPubkey || activeTab === 'all-follows') && (
              <TabsTrigger value="all-follows" className="flex items-center gap-1 h-5 px-2 text-xs border border-gray-300 text-gray-700 rounded-md data-[state=active]:bg-purple-600 data-[state=active]:text-white data-[state=active]:border-purple-600">
                <Users className="h-3 w-3 text-purple-500" />
                <span>All Follows</span>
              </TabsTrigger>
            )}
            {(userPubkey || activeTab === 'discover') && (
              <TabsTrigger value="discover" className="flex items-center gap-1 h-5 px-2 text-xs border border-gray-300 text-gray-700 rounded-md data-[state=active]:bg-purple-600 data-[state=active]:text-white data-[state=active]:border-purple-600">
                <Compass className="h-3 w-3 text-amber-500" />
                <span>Discover</span>
              </TabsTrigger>
            )}
            {!isOnboarding && (
              <>
                <TabsTrigger value="saved" className="group/saved flex items-center gap-1 h-5 px-2 text-xs border border-gray-300 text-gray-700 rounded-md data-[state=active]:bg-purple-600 data-[state=active]:text-white data-[state=active]:border-purple-600">
                  <Save className="h-3 w-3 text-green-500 group-data-[state=active]/saved:text-white" />
                  <span>Saved</span>
                  {collapsedCount > 0 && (
                    <span className="ml-0.5 text-xs text-muted-foreground group-data-[state=active]/saved:text-white group-data-[state=active]/saved:font-semibold">
                      {collapsedCount}
                    </span>
                  )}
                </TabsTrigger>
              </>
            )}

            {/* New Corkboard button — dialog is rendered once via newCorkboardDialog below */}
            {!isOnboarding && (
              <Button
                variant="outline"
                size="sm"
                className="ml-1 h-5 px-2 text-xs border-gray-300 text-gray-700 hover:bg-gray-50 gap-1"
                onClick={() => { setEditingFeedId(null); setFeedTitle(''); setFeedPubkeys(new Set()); setFeedRelays(''); setFeedRssUrls(new Set()); setShowAddFriendDialog(true); }}
              >
                <PlusIcon className="h-3 w-3" />
                New Corkboard
              </Button>
            )}

            {/* Custom feeds (draggable) */}
            {!isOnboarding && <>
            {customFeeds.map((feed, index) => (
              <TabsTrigger
                key={`feed:${feed.id}`}
                value={`feed:${feed.id}`}
                className="flex items-center gap-1 h-5 px-2 text-xs border border-gray-300 text-gray-700 rounded-md data-[state=active]:bg-purple-600 data-[state=active]:text-white data-[state=active]:border-purple-600"
                draggable
                onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(index)); e.dataTransfer.setData('drag-group', 'corkboards'); e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.getData('drag-group') !== 'corkboards') return;
                  const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
                  if (isNaN(fromIndex) || fromIndex === index) return;
                  const reordered = [...customFeeds];
                  const [moved] = reordered.splice(fromIndex, 1);
                  reordered.splice(index, 0, moved);
                  setCustomFeeds(reordered);
                }}
              >
                <Layers className="h-3 w-3 text-purple-500" />
                <span>{feed.title}</span>
              </TabsTrigger>
            ))}

            {/* Friends (draggable) */}
            {/* Browse relays (draggable) */}
            {browseRelays.map((relayUrl, index) => {
              const shortName = relayUrl.replace('wss://', '').replace('ws://', '').split('/')[0];
              return (
                <TabsTrigger
                  key={relayUrl}
                  value={relayUrl}
                  className="flex items-center gap-1 h-5 px-2 text-xs border border-gray-300 text-gray-700 rounded-md data-[state=active]:bg-purple-600 data-[state=active]:text-white data-[state=active]:border-purple-600"
                  draggable
                  onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(index)); e.dataTransfer.setData('drag-group', 'relays'); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (e.dataTransfer.getData('drag-group') !== 'relays') return;
                    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
                    if (isNaN(fromIndex) || fromIndex === index) return;
                    const reordered = [...browseRelays];
                    const [moved] = reordered.splice(fromIndex, 1);
                    reordered.splice(index, 0, moved);
                    setBrowseRelays(reordered);
                  }}
                >
                  <Radio className="h-3 w-3 text-purple-500" />
                  <span>{shortName}</span>
                </TabsTrigger>
              );
            })}

            {/* RSS feeds (draggable) */}
            {rssFeeds.map((feedUrl, index) => {
              const url = new URL(feedUrl);
              const shortName = url.hostname.replace('www.', '').split('.')[0];
              return (
                <TabsTrigger
                  key={`rss:${feedUrl}`}
                  value={`rss:${feedUrl}`}
                  className="flex items-center gap-1 h-5 px-2 text-xs border border-gray-300 text-gray-700 rounded-md data-[state=active]:bg-purple-600 data-[state=active]:text-white data-[state=active]:border-purple-600"
                  draggable
                  onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(index)); e.dataTransfer.setData('drag-group', 'rss'); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (e.dataTransfer.getData('drag-group') !== 'rss') return;
                    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
                    if (isNaN(fromIndex) || fromIndex === index) return;
                    const reordered = [...rssFeeds];
                    const [moved] = reordered.splice(fromIndex, 1);
                    reordered.splice(index, 0, moved);
                    setRssFeeds(reordered);
                  }}
                >
                  <Rss className="h-3 w-3 text-orange-500" />
                  <span>{shortName}</span>
                </TabsTrigger>
              );
            })}
            </>}
          </TabsList>
        </ScrollArea>
      </div>
      {/* Dialog rendered outside TabsList on desktop as well */}
      {!isOnboarding && newCorkboardDialog}

      {/* Sources help dialog */}
      <Dialog open={sourcesHelpOpen} onOpenChange={setSourcesHelpOpen}>
        <DialogContent className="max-w-[95vw] sm:max-w-[450px] max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Adding Sources to a Corkboard</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm text-muted-foreground">
            <p>A corkboard collects posts from multiple sources into one feed. You can add any combination of:</p>
            <div className="space-y-3">
              <div>
                <p className="font-medium text-foreground">Nostr users</p>
                <p className="text-xs">Paste an npub or nprofile address. Separate multiple npubs with commas. You can also select from your follows list below the input.</p>
              </div>
              <div>
                <p className="font-medium text-foreground">RSS feeds</p>
                <p className="text-xs">Paste any RSS or Atom feed URL. Separate multiple feeds with commas. Most blogs, podcasts, and news sites have an RSS feed — look for the orange RSS icon or try adding <code className="bg-muted px-1 rounded">/feed</code> or <code className="bg-muted px-1 rounded">/rss</code> to the site URL.</p>
              </div>
              <div>
                <p className="font-medium text-foreground">YouTube, Reddit, Rumble</p>
                <p className="text-xs">Paste a link to a channel, subreddit, or user page. These platforms support open RSS feeds, so we auto-convert the link for you.</p>
                <ul className="text-xs mt-1 space-y-0.5 list-disc list-inside">
                  <li><strong>YouTube</strong> — channel, @handle, or playlist URL</li>
                  <li><strong>Reddit</strong> — subreddit (<code className="bg-muted px-1 rounded">/r/...</code>) or user page</li>
                  <li><strong>Rumble</strong> — channel URL</li>
                </ul>
              </div>
              <div>
                <p className="font-medium text-foreground">Nostr relays</p>
                <p className="text-xs">Paste a relay URL starting with <code className="bg-muted px-1 rounded">wss://</code> to browse all notes from that relay.</p>
              </div>
            </div>
            <div className="rounded-lg bg-muted/50 border p-3 space-y-1.5">
              <p className="font-medium text-foreground text-xs">What about Twitter, Facebook, Instagram, TikTok?</p>
              <p className="text-xs">These platforms deliberately block RSS feeds, scrape access, and charge for API access. They want your content locked inside their walled gardens where they control who sees what and when.</p>
              <p className="text-xs">That's exactly why Nostr exists — and why Corkboards is built on it. On Nostr, no one can lock you out of your own feed, paywall your followers, or decide your content isn't worth showing. Your posts, your keys, your network.</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}

// ─── Mobile scroll container with arrow indicators ───────────────────────────

function MobileScrollContainer({ children }: { children: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateArrows = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateArrows();
    el.addEventListener('scroll', updateArrows, { passive: true });
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateArrows);
      ro.disconnect();
    };
  }, [updateArrows]);

  return (
    <div className="flex items-center gap-0.5">
      <div className={`shrink-0 flex items-center transition-opacity ${canScrollLeft ? 'opacity-100' : 'opacity-0'}`}>
        <ChevronLeft className="h-4 w-4 text-muted-foreground" />
      </div>
      <div
        ref={scrollRef}
        className="overflow-x-auto scrollbar-hide flex-1 min-w-0"
        style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-x' }}
      >
        {children}
      </div>
      <div className={`shrink-0 flex items-center transition-opacity ${canScrollRight ? 'opacity-100' : 'opacity-0'}`}>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </div>
    </div>
  );
}

// ─── Mobile pill helper ───────────────────────────────────────────────────────

function MobilePill({
  active,
  onClick,
  accent,
  children,
}: {
  active: boolean;
  onClick: () => void;
  accent?: 'amber' | 'green' | 'orange';
  children: React.ReactNode;
}) {
  const activeClass =
    accent === 'amber'  ? 'bg-amber-500 text-white border-amber-500' :
    accent === 'green'  ? 'bg-green-600 text-white border-green-600' :
    accent === 'orange' ? 'bg-orange-500 text-white border-orange-500' :
                          'bg-purple-600 text-white border-purple-600';

  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 h-5 px-2 rounded-md text-xs font-medium whitespace-nowrap transition-colors shrink-0 border ${
        active ? activeClass : 'border-gray-300 text-gray-700 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  );
}
