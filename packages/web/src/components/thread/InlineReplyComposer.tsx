import { useState, useCallback, useRef, useEffect } from 'react'
import type { NostrEvent } from '@nostrify/nostrify'
import { buildReplyTags } from '@core/noteClassifier'
import { useNostrPublish } from '@/hooks/useNostrPublish'
import { useAuthor } from '@/hooks/useAuthor'
import { useUploadFile } from '@/hooks/useUploadFile'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { useToast } from '@/hooks/useToast'
import { genUserName } from '@/lib/genUserName'
import { insertAtCursor } from '@/lib/textareaUtils'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CombinedEmojiPicker } from '@/components/compose/CombinedEmojiPicker'
import { Loader2, Send, X, ImagePlus, Smile } from 'lucide-react'

interface InlineReplyComposerProps {
  replyTo: NostrEvent
  onCancel: () => void
  onPublished: (event: NostrEvent) => void
  onOpenEmojiSets?: () => void
}

export function InlineReplyComposer({ replyTo, onCancel, onPublished, onOpenEmojiSets }: InlineReplyComposerProps) {
  const [content, setContent] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [customEmojiTags, setCustomEmojiTags] = useState<string[][]>([])
  const { mutate: publish, isPending } = useNostrPublish()
  const { mutateAsync: uploadFile } = useUploadFile()
  const { user } = useCurrentUser()
  const { toast } = useToast()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { data: author } = useAuthor(replyTo.pubkey)
  const displayName = author?.metadata?.display_name || author?.metadata?.name || genUserName(replyTo.pubkey)

  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus(), 100)
  }, [])

  const handleMediaUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0 || !user) return
    setIsUploading(true)
    try {
      for (const file of Array.from(files)) {
        const tags = await uploadFile(file)
        const urlTag = tags.find(t => t[0] === 'url')
        if (urlTag?.[1]) setImages(prev => [...prev, urlTag[1]])
      }
    } catch (err) {
      toast({ title: 'Upload failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' })
    } finally {
      setIsUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [user, uploadFile, toast])

  const handleSubmit = useCallback(() => {
    if (!content.trim() && images.length === 0) return
    let finalContent = content.trim()
    if (images.length > 0) finalContent += '\n\n' + images.join('\n')

    const tags: string[][] = [...buildReplyTags(replyTo)]
    const hashtagMatches = finalContent.matchAll(/#([a-zA-Z]\w*)/g)
    for (const match of hashtagMatches) tags.push(['t', match[1].toLowerCase()])
    for (const tag of customEmojiTags) tags.push(tag)

    publish(
      { kind: 1, content: finalContent, tags },
      {
        onSuccess: (event) => {
          setContent('')
          setImages([])
          setCustomEmojiTags([])
          onPublished(event)
        },
      }
    )
  }, [content, images, customEmojiTags, replyTo, publish, onPublished])

  return (
    <div className="border-t bg-background px-4 py-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Replying to <span className="font-medium text-foreground">{displayName}</span>
        </span>
        <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={onCancel}>
          <X className="h-3 w-3" />
        </Button>
      </div>
      <Textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Write your reply..."
        className="min-h-[120px] resize-y text-sm"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            handleSubmit()
          }
        }}
      />
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((url) => (
            <div key={url} className="relative group">
              <img src={url} alt="" className="h-14 w-14 object-cover rounded" />
              <button
                onClick={() => setImages(prev => prev.filter(u => u !== url))}
                className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-0.5">
          <input ref={fileInputRef} type="file" accept="image/*,video/*" multiple onChange={handleMediaUpload} className="hidden" />
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => fileInputRef.current?.click()} disabled={isUploading} title="Upload image or video">
            {isUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Emoji"><Smile className="h-3.5 w-3.5" /></Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-0" align="start" side="top">
              <CombinedEmojiPicker
                onSelectEmoji={(emoji) => {
                  if (textareaRef.current) insertAtCursor(textareaRef.current, emoji, setContent)
                  else setContent(prev => prev + emoji)
                }}
                onSelectCustomEmoji={(shortcode, url) => {
                  if (textareaRef.current) insertAtCursor(textareaRef.current, `:${shortcode}:`, setContent)
                  else setContent(prev => prev + `:${shortcode}:`)
                  setCustomEmojiTags(prev => prev.some(t => t[1] === shortcode) ? prev : [...prev, ['emoji', shortcode, url]])
                }}
                onOpenSetBuilder={onOpenEmojiSets}
              />
            </PopoverContent>
          </Popover>
        </div>
        <Button
          size="sm"
          className="h-7 px-3 gap-1.5 bg-orange-500 hover:bg-orange-600"
          onClick={handleSubmit}
          disabled={isPending || (!content.trim() && images.length === 0)}
        >
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Reply
        </Button>
      </div>
    </div>
  )
}
