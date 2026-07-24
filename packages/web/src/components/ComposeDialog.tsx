import { useState, useRef, useCallback, useEffect } from 'react'
import { type NostrEvent } from '@nostrify/nostrify'
import { buildReplyTags } from '@core/noteClassifier'
import { nip19 } from 'nostr-tools'
import { useNostrPublish } from '@/hooks/useNostrPublish'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { useUploadFile } from '@/hooks/useUploadFile'
import { useToast } from '@/hooks/useToast'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  ResizableDialog,
  ResizableDialogContent,
} from '@/components/ui/resizable-dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { SmartNoteContent } from '@/components/SmartNoteContent'
import { genUserName } from '@/lib/genUserName'
import { optimizeAvatarUrl } from '@/lib/imageUtils'
import { useAuthor } from '@/hooks/useAuthor'
import { getUserRelays, getRelayCache, FALLBACK_RELAYS } from '@/components/NostrProvider'
import {
  ImagePlus,
  X,
  Loader2,
  Send,
  FileText,
  Quote,
  Reply,
  Repeat2,
  Smile,
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CombinedEmojiPicker } from '@/components/compose/CombinedEmojiPicker'
import { insertAtCursor } from '@/lib/textareaUtils'
import { STORAGE_KEYS, CURRENT_PLATFORM, platformKey } from '@/lib/storageKeys'

/** A successfully uploaded media item with its cross-server fallback info. */
interface UploadedMedia {
  url: string
  sha256?: string
  mime?: string
  fallbacks: string[]
}

interface ComposeDialogProps {
  isOpen: boolean
  onClose: () => void
  /** For replies - the event being replied to */
  replyTo?: NostrEvent
  /** For quotes - the event being quoted */
  quotedEvent?: NostrEvent
  /** For reposts - just repost without compose */
  repostEvent?: NostrEvent
  /** Callback after successful publish */
  onPublished?: (event: NostrEvent) => void
  /** Called when user chooses "repost with comment" — switches to quote mode */
  onRepostWithComment?: (event: NostrEvent) => void
  /** Open the emoji set builder dialog */
  onOpenEmojiSets?: () => void
}

export function ComposeDialog({
  isOpen,
  onClose,
  replyTo,
  quotedEvent,
  repostEvent,
  onPublished,
  onRepostWithComment,
  onOpenEmojiSets,
}: ComposeDialogProps) {
  const { user } = useCurrentUser()
  const { mutate: publish, isPending } = useNostrPublish()
  const { mutateAsync: uploadFile } = useUploadFile()
  const { toast } = useToast()

  const [content, setContent] = useState('')
  const [title, setTitle] = useState('') // For long-form
  const [isLongForm, setIsLongForm] = useState(false)
  const [images, setImages] = useState<UploadedMedia[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [customEmojiTags, setCustomEmojiTags] = useState<string[][]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setContent('')
      setTitle('')
      setImages([])
      setIsLongForm(false)
      setCustomEmojiTags([])
    }
  }, [isOpen])

  // Get reply author info
  const { data: replyAuthor } = useAuthor(replyTo?.pubkey || '')
  // Get repost author info (must be called unconditionally)
  const { data: repostAuthor } = useAuthor(repostEvent?.pubkey || '')

  const charCount = content.length

  const handleImageUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    if (!user) {
      toast({ title: 'Please log in to upload images', variant: 'destructive' })
      return
    }

    setIsUploading(true)
    try {
      for (const file of Array.from(files)) {
        // Upload using Blossom protocol with NIP-98 auth
        const tags = await uploadFile(file)
        // Build a media descriptor from the response tags (url + blob metadata
        // + any confirmed cross-server fallback URLs).
        const url = tags.find(t => t[0] === 'url')?.[1]
        if (url) {
          const descriptor: UploadedMedia = {
            url,
            sha256: tags.find(t => t[0] === 'x')?.[1],
            mime: tags.find(t => t[0] === 'm')?.[1],
            fallbacks: tags.filter(t => t[0] === 'fallback').map(t => t[1]),
          }
          setImages(prev => [...prev, descriptor])
        }
      }
      toast({ title: 'Image uploaded' })
    } catch (err) {
      console.error('Upload failed:', err)
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      toast({
        title: 'Upload failed',
        description: errorMessage,
        variant: 'destructive'
      })
    } finally {
      setIsUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [toast, user, uploadFile])

  const removeImage = useCallback((url: string) => {
    setImages(prev => prev.filter(i => i.url !== url))
  }, [])

  const handleSubmit = useCallback(() => {
    if (!content.trim() && images.length === 0) {
      toast({ title: 'Please enter some content', variant: 'destructive' })
      return
    }

    // Build content with images
    let finalContent = content.trim()
    if (images.length > 0) {
      finalContent += '\n\n' + images.map(i => i.url).join('\n')
    }

    // Add quote reference if quoting — NIP-21 requires a bech32 entity
    // (nostr:nevent1…), not a raw hex id, or other clients won't render it.
    const quoteRelayHint = quotedEvent ? (getRelayCache(quotedEvent.pubkey)?.[0] || FALLBACK_RELAYS[0] || '') : ''
    if (quotedEvent) {
      const nevent = nip19.neventEncode({
        id: quotedEvent.id,
        author: quotedEvent.pubkey,
        relays: quoteRelayHint ? [quoteRelayHint] : [],
      })
      finalContent += `\n\nnostr:${nevent}`
    }

    // Build tags
    const tags: string[][] = []

    // Reply tags (NIP-10)
    if (replyTo) {
      tags.push(...buildReplyTags(replyTo));
    }

    // Quote tags — NIP-18: ['q', id, relay hint, pubkey]
    if (quotedEvent) {
      tags.push(['q', quotedEvent.id, quoteRelayHint, quotedEvent.pubkey])
      tags.push(['p', quotedEvent.pubkey])
    }

    // Extract hashtags
    const hashtagMatches = finalContent.matchAll(/#([a-zA-Z]\w*)/g)
    for (const match of hashtagMatches) {
      tags.push(['t', match[1].toLowerCase()])
    }

    // Long-form specific
    if (isLongForm) {
      const dTag = `${Date.now()}`
      tags.push(['d', dTag])
      if (title) tags.push(['title', title])
      tags.push(['published_at', Math.floor(Date.now() / 1000).toString()])
    }

    // Add custom emoji tags (NIP-30) — validate format before publishing
    for (const tag of customEmojiTags) {
      if (tag.length >= 3 && tag[0] === 'emoji' && /^[\w-]{1,64}$/.test(tag[1]) && tag[2].startsWith('https://')) {
        tags.push(tag)
      }
    }

    // Emit one NIP-92 imeta tag per uploaded image so readers can rebuild the
    // blob across Blossom servers (sha256 + confirmed fallback URLs) when the
    // primary URL's server prunes the file.
    for (const img of images) {
      const imeta = ['imeta', 'url ' + img.url]
      if (img.sha256) imeta.push('x ' + img.sha256)
      if (img.mime) imeta.push('m ' + img.mime)
      for (const fb of img.fallbacks) imeta.push('fallback ' + fb)
      tags.push(imeta)
    }

    const kind = isLongForm ? 30023 : 1

    publish(
      { kind, content: finalContent, tags },
      {
        onSuccess: (event) => {
          toast({ title: replyTo ? 'Reply posted' : quotedEvent ? 'Quote posted' : 'Note posted' })
          setContent('')
          setTitle('')
          setImages([])
          setIsLongForm(false)
          setCustomEmojiTags([])
          onPublished?.(event)
          onClose()
        },
        onError: (err) => {
          const msg = err instanceof Error ? err.message : String(err)
          toast({ title: 'Failed to post', description: msg, variant: 'destructive' })
        },
      }
    )
  }, [content, images, quotedEvent, replyTo, isLongForm, title, publish, toast, onPublished, onClose, customEmojiTags])

  // Handle repost (kind 6 for kind 1, kind 16 for others per NIP-18)
  const handleRepost = useCallback(() => {
    if (!repostEvent) return

    // Relay hint should point to where the original event can be found:
    // prefer the original author's cached relays, fall back to user's write relays
    const authorRelays = getRelayCache(repostEvent.pubkey);
    const userRelays = getUserRelays();
    const relayHint = authorRelays[0] || userRelays.write[0] || FALLBACK_RELAYS[0] || '';

    const isKind1 = repostEvent.kind === 1;
    const repostKind = isKind1 ? 6 : 16;

    const tags: string[][] = [
      ['e', repostEvent.id, relayHint],
      ['p', repostEvent.pubkey],
    ]
    // Generic reposts (kind 16) must include a k tag per NIP-18
    if (!isKind1) {
      tags.push(['k', String(repostEvent.kind)]);
    }

    publish(
      { kind: repostKind, content: JSON.stringify(repostEvent), tags },
      {
        onSuccess: (event) => {
          toast({ title: 'Reposted' })
          onPublished?.(event)
          onClose()
        },
        onError: () => {
          toast({ title: 'Failed to repost', variant: 'destructive' })
        },
      }
    )
  }, [repostEvent, publish, toast, onPublished, onClose])

  // If it's a repost, show simple confirmation with optional comment
  const [repostAddComment, setRepostAddComment] = useState(false)
  // Reset checkbox when dialog opens/closes
  useEffect(() => {
    if (isOpen && repostEvent) setRepostAddComment(false)
  }, [isOpen, repostEvent])

  if (repostEvent) {
    const authorName = repostAuthor?.metadata?.display_name || repostAuthor?.metadata?.name || genUserName(repostEvent.pubkey)

    return (
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Repeat2 className="h-5 w-5" />
              Repost
            </DialogTitle>
            <DialogDescription className="sr-only">Repost this note to your followers</DialogDescription>
          </DialogHeader>
          <div className="p-3 bg-muted/50 rounded-lg max-h-48 overflow-y-auto">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
              <Avatar className="h-5 w-5">
                {repostAuthor?.metadata?.picture && <AvatarImage src={optimizeAvatarUrl(repostAuthor.metadata.picture) || ''} />}
                <AvatarFallback className="text-[8px]">{authorName.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="font-medium">{authorName}</span>
            </div>
            <p className="text-sm line-clamp-4">{repostEvent.content.slice(0, 300)}{repostEvent.content.length > 300 && '...'}</p>
          </div>
          {onRepostWithComment && (
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox checked={repostAddComment} onCheckedChange={(v) => setRepostAddComment(!!v)} />
              <span className="text-sm">Add a comment</span>
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button
              onClick={repostAddComment && onRepostWithComment ? () => onRepostWithComment(repostEvent) : handleRepost}
              disabled={isPending}
              className="bg-orange-500 hover:bg-orange-600"
            >
              {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Repeat2 className="h-4 w-4 mr-2" />}
              {repostAddComment ? 'Write comment & repost' : 'Repost'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  const dialogTitleText = replyTo ? 'Reply' : quotedEvent ? 'Quote' : isLongForm ? 'New Article' : 'New Post'
  const dialogIcon = replyTo ? <Reply className="h-4 w-4" /> : quotedEvent ? <Quote className="h-4 w-4" /> : <Send className="h-4 w-4" />

  return (
    <ResizableDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ResizableDialogContent
        defaultWidth={Math.round(window.innerWidth * 0.5)}
        defaultHeight={Math.round(window.innerHeight * 0.65)}
        minWidth={350}
        minHeight={280}
        storageKey={platformKey(CURRENT_PLATFORM, STORAGE_KEYS.COMPOSE_DIALOG_GEOMETRY)}
        dialogDescription="Write and publish a new note"
        dialogTitle={
          <span className="flex items-center gap-2">
            {dialogIcon}
            {dialogTitleText}
          </span>
        }
      >
        <div className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto">
          {/* Reply context */}
          {replyTo && (
            <div className="p-2 bg-muted/50 rounded-lg text-sm">
              <div className="flex items-center gap-2 text-muted-foreground mb-1">
                <Reply className="h-3 w-3" />
                <span>Replying to</span>
                <span className="font-medium text-foreground">
                  {replyAuthor?.metadata?.display_name || replyAuthor?.metadata?.name || genUserName(replyTo.pubkey)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground line-clamp-2">{replyTo.content.slice(0, 150)}</p>
            </div>
          )}

          {/* Quote context */}
          {quotedEvent && (
            <div className="p-2 bg-muted/50 rounded-lg border-l-2 border-primary">
              <SmartNoteContent event={quotedEvent} className="text-sm" />
            </div>
          )}

          {/* Long-form toggle (not for replies) */}
          {!replyTo && !quotedEvent && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <Label htmlFor="long-form" className="text-sm">Long-form article</Label>
              </div>
              <Switch id="long-form" checked={isLongForm} onCheckedChange={setIsLongForm} />
            </div>
          )}

          {/* Title for long-form */}
          {isLongForm && (
            <Input
              placeholder="Article title..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="font-semibold"
            />
          )}

          {/* Content */}
          <div>
            <Textarea
              ref={textareaRef}
              placeholder={replyTo ? "Write your reply..." : isLongForm ? "Write your article..." : "What's happening?"}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              style={{ resize: 'vertical', minHeight: `${Math.round(window.innerHeight * 0.5)}px` }}
            />
            <div className="text-xs text-muted-foreground text-right mt-1">
              {charCount.toLocaleString()}
            </div>
          </div>

          {/* Image previews */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((img) => (
                <div key={img.url} className="relative group">
                  <img src={img.url} alt="" className="h-20 w-20 object-cover rounded" referrerPolicy="no-referrer" />
                  <button
                    onClick={() => removeImage(img.url)}
                    className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Media toolbar */}
          <div className="flex items-center justify-between border-t pt-2">
            <div className="flex items-center gap-1">
              {/* Image/Video upload */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                multiple
                onChange={handleImageUpload}
                className="hidden"
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                title="Upload image or video"
              >
                {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
              </Button>

              {/* Emoji picker (standard + custom in tabs) */}
              {/* modal: give the popover its own scroll-lock context so the emoji
                  picker scrolls inside the compose Dialog (the Dialog's
                  react-remove-scroll otherwise blocks wheel/touch on it). */}
              <Popover modal>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Emoji">
                    <Smile className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[min(20rem,calc(100vw-1rem))] p-0" align="start" side="top">
                  <CombinedEmojiPicker
                    onSelectEmoji={(emoji) => {
                      if (textareaRef.current) insertAtCursor(textareaRef.current, emoji, setContent);
                      else setContent(prev => prev + emoji);
                    }}
                    onSelectCustomEmoji={(shortcode, url) => {
                      if (textareaRef.current) insertAtCursor(textareaRef.current, `:${shortcode}:`, setContent);
                      else setContent(prev => prev + `:${shortcode}:`);
                      setCustomEmojiTags(prev => {
                        if (prev.some(t => t[1] === shortcode)) return prev;
                        return [...prev, ['emoji', shortcode, url]];
                      });
                    }}
                    onOpenSetBuilder={onOpenEmojiSets}
                  />
                </PopoverContent>
              </Popover>


            </div>

            <Button
              onClick={handleSubmit}
              disabled={isPending || (!content.trim() && images.length === 0)}
              className="bg-orange-500 hover:bg-orange-600"
            >
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : replyTo ? (
                <Reply className="h-4 w-4 mr-2" />
              ) : (
                <Send className="h-4 w-4 mr-2" />
              )}
              {replyTo ? 'Reply' : quotedEvent ? 'Quote' : 'Post'}
            </Button>
          </div>
        </div>
      </ResizableDialogContent>
    </ResizableDialog>
  )
}
