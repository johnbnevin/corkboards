/**
 * NotificationCard — displays a single Nostr notification with full context.
 *
 * Shows:
 *   - Who sent the notification (actor) and what they did
 *   - Their content (reply text, reaction emoji, repost comment, etc.)
 *   - The target note being reacted to / replied to / reposted (with expandable content)
 */

import React, { useMemo, useState, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@/hooks/useNostr';
import { useAuthor } from '@/hooks/useAuthor';
import { useCollapsedNotes } from '@/hooks/useCollapsedNotes';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { SmartNoteContent } from '@/components/SmartNoteContent';
import { NoteContent } from '@/components/NoteContent';
import { visibleLength, findVisibleCutoff } from '@/lib/textTruncation';
import { ClickableProfile } from '@/components/ProfileModal';
import { CopyEventIdButton } from '@/components/NoteCard';
import { genUserName } from '@/lib/genUserName';
import { formatTimeAgoCompact } from '@/lib/formatTimeAgo';
import { optimizeAvatarUrl } from '@/lib/imageUtils';
import { fetchEventWithOutbox } from '@/lib/fetchEvent';
import { type NotificationItem, getZapAmountSats } from '@/hooks/useNotifications';
import {
  MessageSquare, Repeat2, Heart, Zap, AtSign,
  ExternalLink, RotateCw,
} from 'lucide-react';

// Preserve dismissed/collapsed note heights across tab switches
const MAX_CAPTURED_HEIGHTS = 5000;
const capturedHeights = new Map<string, number>();
function setNotifCapturedHeight(noteId: string, height: number): void {
  if (capturedHeights.size >= MAX_CAPTURED_HEIGHTS && !capturedHeights.has(noteId)) {
    capturedHeights.delete(capturedHeights.keys().next().value!);
  }
  capturedHeights.set(noteId, height);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// visibleLength and findVisibleCutoff imported from @/lib/textTruncation

/** Expandable note content — truncates at 150 chars with show-more */
function ExpandableContent({
  event,
  className,
  onViewThread,
}: {
  event: NostrEvent;
  className?: string;
  onViewThread?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visLen = visibleLength(event.content);
  const canExpand = visLen > 150;

  if (expanded) {
    return (
      <div>
        <SmartNoteContent event={event} className={className} blurMedia onViewThread={onViewThread} />
        <button
          className="text-xs text-primary mt-1 hover:underline"
          onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
        >
          Show less
        </button>
      </div>
    );
  }

  return (
    <div>
      <NoteContent
        event={visLen > 150
          ? { ...event, content: event.content.slice(0, findVisibleCutoff(event.content, 150)).trimEnd() + '…' }
          : event}
        className={className}
        blurMedia
      />
      {canExpand && (
        <button
          className="text-xs text-primary mt-1 hover:underline"
          onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
        >
          Show more
        </button>
      )}
    </div>
  );
}

// ─── Target note context block ────────────────────────────────────────────────

function TargetNoteContext({
  targetEventId,
  targetRelayHint,
  targetAuthorPubkey,
  onViewThread,
  padRight = false,
}: {
  targetEventId: string;
  targetRelayHint: string | null;
  targetAuthorPubkey: string | null;
  onViewThread?: (id: string) => void;
  padRight?: boolean;
}) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const { data: targetEvent, isLoading, isFetching } = useQuery({
    queryKey: ['notif-target', targetEventId],
    queryFn: async () => {
      const event = await fetchEventWithOutbox(targetEventId, nostr, {
        hints: targetRelayHint ? [targetRelayHint] : [],
        authorPubkey: targetAuthorPubkey ?? undefined,
      });
      if (!event) throw new Error('not found');
      return event;
    },
    staleTime: 10 * 60_000,
    retry: 3,
    retryDelay: (attempt) => [2000, 5000, 15000][attempt] ?? 15000,
  });

  const { data: targetAuthor } = useAuthor(targetEvent?.pubkey ?? '');
  const targetDisplayName = targetAuthor?.metadata?.display_name ||
    targetAuthor?.metadata?.name ||
    (targetEvent?.pubkey ? genUserName(targetEvent.pubkey) : '');
  const targetAvatar = optimizeAvatarUrl(targetAuthor?.metadata?.picture);

  if (isLoading) {
    return (
      <div className="mt-2 p-2.5 bg-muted/30 rounded-lg border-l-2 border-muted-foreground/20">
        <Skeleton className="h-3 w-24 mb-1.5" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4 mt-1" />
      </div>
    );
  }

  if (!targetEvent) {
    return (
      <div className="mt-2 p-2.5 bg-muted/20 rounded-lg border-l-2 border-muted-foreground/10 flex items-center gap-2">
        <div className="flex flex-col gap-0.5">
          <p className="text-xs text-muted-foreground/50 italic">{isFetching ? 'Retrying…' : 'Original note unavailable'}</p>
          {targetRelayHint && !isFetching && (
            <span className="text-[10px] text-muted-foreground/30 font-mono">{targetRelayHint.replace(/^wss?:\/\//, '')}</span>
          )}
        </div>
        <button type="button" onClick={(e) => { e.stopPropagation(); queryClient.invalidateQueries({ queryKey: ['notif-target', targetEventId] }) }} className="p-0.5 text-muted-foreground/50 hover:text-foreground transition-colors" title="Retry"><RotateCw className={`h-3 w-3${isFetching ? ' animate-spin' : ''}`} /></button>
      </div>
    );
  }

  return (
    <div
      className={`mt-2 p-2.5 bg-muted/30 rounded-lg border-l-2 border-purple-300/40 dark:border-purple-500/30 cursor-pointer hover:bg-muted/50 transition-colors ${padRight ? 'pr-12' : ''}`}
      onClick={(e) => { e.stopPropagation(); onViewThread?.(targetEventId); }}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
        <ClickableProfile pubkey={targetEvent.pubkey} className="flex items-center gap-1 hover:opacity-80 transition-opacity">
          <Avatar className="h-3.5 w-3.5">
            {targetAvatar && <AvatarImage src={targetAvatar} alt={targetDisplayName} />}
            <AvatarFallback className="text-[7px]">{targetDisplayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="font-medium text-foreground/70 text-[11px]">{targetDisplayName}</span>
        </ClickableProfile>
        <span className="text-muted-foreground/50">·</span>
        <span className="text-[10px] text-muted-foreground/50">
          {formatTimeAgoCompact(targetEvent.created_at)}
        </span>
      </div>
      <ExpandableContent event={targetEvent} className="text-xs text-muted-foreground" onViewThread={onViewThread} />
    </div>
  );
}

// ─── NotificationCard ─────────────────────────────────────────────────────────

interface NotificationCardProps {
  notification: NotificationItem;
  onViewThread?: (eventId: string) => void;
}

export const NotificationCard = React.memo(function NotificationCard({
  notification,
  onViewThread,
}: NotificationCardProps) {
  const { event, type, targetEventId, targetRelayHint, targetAuthorPubkey, senderPubkey } = notification;
  const { isCollapsed, isCollapsedThisSession, isSoftDismissed, toggleCollapsed, dismiss, undoDismiss, canUndoDismiss } = useCollapsedNotes();
  const cardRef = useRef<HTMLDivElement>(null);

  // For zaps, the event.pubkey is the LNURL server — use senderPubkey (from zap request) instead
  const actorPubkey = (type === 'zap' && senderPubkey) ? senderPubkey : event.pubkey;

  const { data: actor } = useAuthor(actorPubkey);
  const actorName = actor?.metadata?.display_name || actor?.metadata?.name || genUserName(actorPubkey);
  const actorAvatar = optimizeAvatarUrl(actor?.metadata?.picture);
  const timeAgo = useMemo(() => formatTimeAgoCompact(event.created_at), [event.created_at]);

  const collapsed = isCollapsed(event.id);
  const softDismissed = isSoftDismissed(event.id);

  // Capture height while expanded
  useEffect(() => {
    if (!collapsed && !softDismissed && cardRef.current) {
      setNotifCapturedHeight(event.id, cardRef.current.offsetHeight);
    }
  }, [collapsed, softDismissed, event.id]);

  // Reaction content: emoji, custom emoji, or "+"
  const { reactionEmoji, reactionCustomUrl } = useMemo(() => {
    if (type !== 'reaction') return { reactionEmoji: null, reactionCustomUrl: undefined };
    const content = event.content.trim();
    if (content === '+' || content === '-') return { reactionEmoji: content === '+' ? '❤️' : '👎', reactionCustomUrl: undefined };
    // NIP-30 custom emoji: content is :shortcode:, look up URL from emoji tag
    const customMatch = content.match(/^:([^:]+):$/);
    if (customMatch) {
      const url = event.tags.find(t => t[0] === 'emoji' && t[1] === customMatch[1])?.[2];
      if (url) return { reactionEmoji: content, reactionCustomUrl: url };
    }
    return { reactionEmoji: content || '❤️', reactionCustomUrl: undefined };
  }, [type, event.content, event.tags]);

  // Zap amount
  const zapSats = useMemo(() => getZapAmountSats(event), [event]);

  // Repost: try to get embedded event content
  const repostComment = useMemo(() => {
    if (type !== 'repost') return null;
    if (!event.content) return null;
    try {
      JSON.parse(event.content);
      return null;
    } catch {
      return event.content.trim() || null;
    }
  }, [type, event.content]);

  // Icon and label for notification type
  const { icon, label, accentColor } = useMemo(() => {
    switch (type) {
      case 'reaction':
        return {
          icon: <Heart className="h-3.5 w-3.5" />,
          label: 'reacted',
          accentColor: 'text-pink-500',
        };
      case 'reply':
        return {
          icon: <MessageSquare className="h-3.5 w-3.5" />,
          label: 'replied',
          accentColor: 'text-blue-500',
        };
      case 'mention':
        return {
          icon: <AtSign className="h-3.5 w-3.5" />,
          label: 'mentioned you',
          accentColor: 'text-purple-500',
        };
      case 'repost':
        return {
          icon: <Repeat2 className="h-3.5 w-3.5" />,
          label: 'reposted',
          accentColor: 'text-green-500',
        };
      case 'zap':
        return {
          icon: <Zap className="h-3.5 w-3.5" />,
          label: zapSats ? `zapped ${zapSats.toLocaleString()} sats` : 'zapped',
          accentColor: 'text-amber-500',
        };
      default:
        return {
          icon: <MessageSquare className="h-3.5 w-3.5" />,
          label: type,
          accentColor: 'text-muted-foreground',
        };
    }
  }, [type, zapSats]);

  // For reactions, reposts, and zaps, open the thread for the target note (the note being
  // reacted to / reposted / zapped). For replies and mentions, event.id IS the relevant note.
  const threadTargetId = (type === 'reaction' || type === 'repost' || type === 'zap')
    ? (targetEventId || event.id)
    : event.id;

  const handleCardClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('a, button, iframe, video, input')) return;
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) return;
    onViewThread?.(threadTargetId);
  };

  const placeholderStyle = capturedHeights.has(event.id) ? { height: capturedHeights.get(event.id) } : { minHeight: 40 };

  // Soft-dismissed placeholder
  if (softDismissed) {
    const canUndo = canUndoDismiss(event.id);
    return (
      <Card
        className={`border-dashed border-muted-foreground/15 bg-transparent flex items-center justify-center ${canUndo ? 'cursor-pointer hover:bg-accent/20 transition-colors' : ''}`}
        style={placeholderStyle}
        onClick={canUndo ? () => undoDismiss(event.id) : undefined}
      >
        <span className="text-[11px] text-muted-foreground/30 select-none">{canUndo ? 'undo' : 'dismissed'}</span>
      </Card>
    );
  }

  // Collapsed placeholder (saved for later)
  if (collapsed && isCollapsedThisSession(event.id)) {
    return (
      <Card
        className="border-dashed border-muted-foreground/15 bg-transparent flex items-center justify-center cursor-pointer hover:bg-accent/20 transition-colors"
        style={placeholderStyle}
        onClick={() => toggleCollapsed(event.id)}
        title="Click to expand"
      >
        <span className="text-[11px] text-muted-foreground/30 select-none">saved for later</span>
      </Card>
    );
  }

  return (
    <div ref={cardRef} data-note-id={event.id}>
    <Card
      className="relative cursor-pointer hover:bg-accent/50 transition-colors group/card overflow-hidden"
      onClick={handleCardClick}
    >
      {/* Save for later — green corner, top-left */}
      <button
        className="absolute top-0 left-0 w-11 h-11 transition-opacity z-20 opacity-40 group-hover/card:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          if (cardRef.current) setNotifCapturedHeight(event.id, cardRef.current.offsetHeight);
          toggleCollapsed(event.id);
        }}
        title="Save for later"
      >
        <div className="w-0 h-0 border-t-[44px] border-r-[44px] border-t-green-500 border-r-transparent active:border-t-green-400 md:hover:border-t-green-400 transition-colors" />
      </button>

      {/* Dismiss — red corner, top-right */}
      <button
        className="absolute top-0 right-0 w-11 h-11 transition-opacity z-20 opacity-40 group-hover/card:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          if (cardRef.current) setNotifCapturedHeight(event.id, cardRef.current.offsetHeight);
          dismiss(event.id);
        }}
        title="Dismiss notification"
      >
        <div className="w-0 h-0 border-t-[44px] border-l-[44px] border-t-red-500 border-l-transparent active:border-t-red-400 md:hover:border-t-red-400 transition-colors" />
      </button>

      <CardHeader className="pb-1.5 pt-8 px-3">
        {/* Actor + action header */}
        <div className="flex items-center gap-2 flex-wrap">
          <ClickableProfile pubkey={actorPubkey} className="flex items-center gap-1.5 hover:opacity-80 transition-opacity shrink-0">
            <Avatar className="h-6 w-6">
              {actorAvatar && <AvatarImage src={actorAvatar} alt={actorName} />}
              <AvatarFallback className="text-[9px]">{actorName.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="text-sm font-semibold leading-tight">{actorName}</span>
          </ClickableProfile>
          <div className={`flex items-center gap-1 text-xs font-medium ${accentColor}`}>
            {icon}
            <span>{label}</span>
          </div>
          <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{timeAgo}</span>
        </div>
      </CardHeader>

      <CardContent className="px-3 pb-3 pt-0 space-y-0">
        {/* Notification content */}
        {(type === 'reply' || type === 'mention') && (
          <ExpandableContent event={event} className="text-sm" onViewThread={onViewThread} />
        )}

        {type === 'repost' && repostComment && (
          <div className="text-sm text-foreground/80 italic">
            "{repostComment}"
          </div>
        )}

        {/* Target note context — shown for all types that have a target */}
        {targetEventId && (
          <div className="relative">
            <TargetNoteContext
              targetEventId={targetEventId}
              targetRelayHint={targetRelayHint}
              targetAuthorPubkey={targetAuthorPubkey}
              onViewThread={onViewThread}
              padRight={type === 'reaction' && !!reactionEmoji}
            />
            {type === 'reaction' && reactionEmoji && (
              reactionCustomUrl ? (
                <img
                  src={reactionCustomUrl}
                  alt={reactionEmoji}
                  className="absolute -top-1 -right-1 h-10 w-10 drop-shadow-md select-none object-contain"
                />
              ) : (
                <span className="absolute -top-1 -right-1 text-4xl drop-shadow-md select-none">
                  {reactionEmoji === '+' ? '👍' : reactionEmoji === '-' ? '👎' : reactionEmoji}
                </span>
              )
            )}
          </div>
        )}
        {/* Reaction emoji standalone — only when no target note to overlay */}
        {type === 'reaction' && reactionEmoji && !targetEventId && (
          reactionCustomUrl ? (
            <img src={reactionCustomUrl} alt={reactionEmoji} className="h-10 w-10 object-contain my-1 drop-shadow-md select-none" referrerPolicy="no-referrer" />
          ) : (
            <div className="text-4xl leading-none py-1 select-none drop-shadow-md">
              {reactionEmoji === '+' ? '👍' : reactionEmoji === '-' ? '👎' : reactionEmoji}
            </div>
          )
        )}

        {/* Footer actions */}
        <div className="flex items-center gap-1 mt-2 opacity-0 group-hover/card:opacity-100 transition-opacity">
          <CopyEventIdButton eventId={event.id} size="small" />
          {(targetEventId || type === 'reply' || type === 'mention') && (
            <button
              className="inline-flex items-center gap-1 h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                onViewThread?.(threadTargetId);
              }}
              title="View thread"
            >
              <ExternalLink className="h-2.5 w-2.5" />
              Thread
            </button>
          )}
        </div>
      </CardContent>
    </Card>
    </div>
  );
});
