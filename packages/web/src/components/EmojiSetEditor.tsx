/**
 * Emoji Set Editor — create, edit, and delete NIP-30 custom emoji sets (kind 30030).
 * Supports bulk image/GIF upload via Blossom, inline shortcode editing,
 * importing from other users' public sets, and emoji favorites tracking.
 * All Nostr-native — no third-party APIs.
 */
import { useState, useCallback, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNostrPublish } from '@/hooks/useNostrPublish'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { useNostr } from '@/hooks/useNostr'
import { useCustomEmojiSets, type EmojiSet, type CustomEmoji } from '@/hooks/useCustomEmojiSets'
import { useUploadFile } from '@/hooks/useUploadFile'
import { useToast } from '@/hooks/useToast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Card } from '@/components/ui/card'
import { isValidMediaUrl } from '@/lib/textareaUtils'
import { CATEGORIES as EMOJI_CATEGORIES } from '@/components/compose/EmojiPicker'
import {
  Plus,
  Trash2,
  Save,
  ImagePlus,
  Loader2,
  ArrowLeft,
  Star,
  X,
  Pencil,
  Check,
  ArrowUp,
  ArrowDown,
  Download,
  Search,
  Copy,
  Smile,
  Palette,
} from 'lucide-react'

/**
 * Default emoji set — a well-known set address that new users auto-get.
 * Set this to your own pubkey + d-tag after building the set in-app.
 * Format: "30030:<pubkey>:<d-tag>"
 */
export const DEFAULT_EMOJI_SET_ADDR: string | null = null
// e.g. '30030:abc123...pubkey:corkboards-default'

// ---- Favorites tracking ----
const FAVORITES_STORAGE_KEY = 'corkboard:emoji-favorites'
const MAX_FAVORITES = 50

function getEmojiFavorites(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) || '{}')
  } catch { return {} }
}

// eslint-disable-next-line react-refresh/only-export-components
export function trackEmojiUse(emoji: string) {
  const favs = getEmojiFavorites()
  favs[emoji] = (favs[emoji] || 0) + 1
  const sorted = Object.entries(favs).sort((a, b) => b[1] - a[1]).slice(0, MAX_FAVORITES)
  localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Object.fromEntries(sorted)))
}

function getTopFavorites(n = 32): string[] {
  const favs = getEmojiFavorites()
  return Object.entries(favs).sort((a, b) => b[1] - a[1]).slice(0, n).map(([emoji]) => emoji)
}

// ---- Main component ----
type EditorView = 'list' | 'edit' | 'favorites' | 'browse'

interface EditingSet {
  dTag: string
  name: string
  emojis: CustomEmoji[]
  isNew: boolean
}

export function EmojiSetEditor() {
  const { sets, isLoading } = useCustomEmojiSets()
  const { mutateAsync: publish } = useNostrPublish()
  const { user } = useCurrentUser()
  const { nostr } = useNostr()
  const { mutateAsync: uploadFile } = useUploadFile()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [view, setView] = useState<EditorView>('list')
  const [editing, setEditing] = useState<EditingSet | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Delete confirmation from list view
  const [confirmDeleteSet, setConfirmDeleteSet] = useState<EmojiSet | null>(null)
  const [isDeletingFromList, setIsDeletingFromList] = useState(false)

  // Fetch kind 10030 (emoji favorites list) for removing followed sets
  const { data: favoritesEvent } = useQuery({
    queryKey: ['emoji-favorites-list', user?.pubkey],
    queryFn: async ({ signal }) => {
      if (!user?.pubkey) return null
      const events = await nostr.query(
        [{ kinds: [10030], authors: [user.pubkey], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      )
      return events[0] ?? null
    },
    enabled: !!user?.pubkey,
    staleTime: 5 * 60_000,
  })

  /** Delete a set from the list view — handles both owned and followed sets */
  const handleDeleteFromList = useCallback(async (set: EmojiSet) => {
    if (!user) return
    setIsDeletingFromList(true)
    try {
      const isOwned = set.pubkey === user.pubkey
      if (isOwned) {
        // Delete own set: publish empty kind 30030 with same d-tag
        await publish({ kind: 30030, content: '', tags: [['d', set.dTag]] } as never)
      } else {
        // Remove followed set: update kind 10030 (remove the matching 'a' tag)
        const addrToRemove = `30030:${set.pubkey}:${set.dTag}`
        const existingTags = favoritesEvent?.tags ?? []
        const newTags = existingTags.filter(t => !(t[0] === 'a' && t[1] === addrToRemove))
        await publish({ kind: 10030, content: '', tags: newTags } as never)
      }
      toast({ title: isOwned ? 'Deleted' : 'Removed from collection' })
      queryClient.invalidateQueries({ queryKey: ['custom-emoji-sets'] })
      queryClient.invalidateQueries({ queryKey: ['emoji-favorites-list'] })
    } catch (err) {
      toast({ title: 'Delete failed', description: String(err), variant: 'destructive' })
    } finally {
      setIsDeletingFromList(false)
      setConfirmDeleteSet(null)
    }
  }, [user, publish, favoritesEvent, toast, queryClient])

  // Inline shortcode editing
  const [editingShortcode, setEditingShortcode] = useState<string | null>(null)
  const [editingShortcodeValue, setEditingShortcodeValue] = useState('')

  // Manual URL input
  const [manualUrl, setManualUrl] = useState('')
  const [manualShortcode, setManualShortcode] = useState('')

  // Inline panels in edit view
  type EditPanel = null | 'emoji' | 'mysets'
  const [activePanel, setActivePanel] = useState<EditPanel>(null)
  const [emojiCategory, setEmojiCategory] = useState(0)
  const [mySetsTab, setMySetsTab] = useState(0)

  // Browse public sets
  const [browseQuery, setBrowseQuery] = useState('')

  // Favorites
  const favorites = useMemo(() => getTopFavorites(32), [])

  // Browse public emoji sets from Nostr — auto-loads on open, narrows with search
  const { data: publicSets, isFetching: isBrowsing } = useQuery({
    queryKey: ['public-emoji-sets', browseQuery],
    queryFn: async ({ signal }) => {
      const q = browseQuery.trim()
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(10000)])

      // Build queries — broad discovery when no search, filtered when searching
      type EmojiEvent = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string };
      const queries: Promise<EmojiEvent[]>[] = []

      if (q) {
        queries.push(
          nostr.query([{ kinds: [30030], search: q, limit: 20 }], { signal: timeout }).catch(() => []),
          nostr.query([{ kinds: [30030], '#d': [q], limit: 10 }], { signal: timeout }).catch(() => []),
        )
      } else {
        // Discover sets from relays — no search filter, just recent sets
        queries.push(
          nostr.query([{ kinds: [30030], limit: 40 }], { signal: timeout }).catch(() => []),
        )
      }

      const results = await Promise.all(queries)
      const all = results.flat()

      // Deduplicate by pubkey:dTag
      const byKey = new Map<string, typeof all[0]>()
      for (const ev of all) {
        const dTag = ev.tags.find(t => t[0] === 'd')?.[1] ?? ''
        const key = `${ev.pubkey}:${dTag}`
        const existing = byKey.get(key)
        if (!existing || ev.created_at > existing.created_at) byKey.set(key, ev)
      }

      return Array.from(byKey.values())
        .map(ev => {
          const dTag = ev.tags.find(t => t[0] === 'd')?.[1] ?? ''
          const title = ev.tags.find(t => t[0] === 'title')?.[1]
          const emojis = ev.tags
            .filter(t => t[0] === 'emoji' && t[1] && t[2])
            .map(t => ({ shortcode: t[1], url: t[2] }))
          return { name: title || dTag || 'Untitled', dTag, emojis, pubkey: ev.pubkey }
        })
        .filter(s => s.emojis.length > 0)
        .sort((a, b) => b.emojis.length - a.emojis.length)
        .slice(0, 30)
    },
    enabled: view === 'browse',
    staleTime: 60_000,
  })

  // ---- Actions ----

  const startNewSet = useCallback(() => {
    setEditing({ dTag: `emoji-${Date.now()}`, name: '', emojis: [], isNew: true })
    setView('edit')
  }, [])

  const startEditSet = useCallback((set: EmojiSet) => {
    setEditing({ dTag: set.dTag, name: set.name, emojis: [...set.emojis], isNew: false })
    setView('edit')
  }, [])

  const addEmojiToSet = useCallback((shortcode: string, url: string) => {
    if (!editing) return
    if (editing.emojis.some(e => e.shortcode === shortcode)) return
    setEditing({ ...editing, emojis: [...editing.emojis, { shortcode, url }] })
  }, [editing])

  const removeEmojiFromSet = useCallback((shortcode: string) => {
    if (!editing) return
    setEditing({ ...editing, emojis: editing.emojis.filter(e => e.shortcode !== shortcode) })
  }, [editing])

  const moveEmoji = useCallback((shortcode: string, direction: 'up' | 'down') => {
    if (!editing) return
    const idx = editing.emojis.findIndex(e => e.shortcode === shortcode)
    if (idx < 0) return
    const newIdx = direction === 'up' ? idx - 1 : idx + 1
    if (newIdx < 0 || newIdx >= editing.emojis.length) return
    const newEmojis = [...editing.emojis]
    ;[newEmojis[idx], newEmojis[newIdx]] = [newEmojis[newIdx], newEmojis[idx]]
    setEditing({ ...editing, emojis: newEmojis })
  }, [editing])

  const renameEmoji = useCallback((oldShortcode: string, newShortcode: string) => {
    if (!editing) return
    const clean = newShortcode.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)
    if (!clean || clean === oldShortcode) { setEditingShortcode(null); return }
    if (editing.emojis.some(e => e.shortcode === clean && e.shortcode !== oldShortcode)) {
      toast({ title: 'Duplicate shortcode', variant: 'destructive' })
      return
    }
    setEditing({
      ...editing,
      emojis: editing.emojis.map(e => e.shortcode === oldShortcode ? { ...e, shortcode: clean } : e),
    })
    setEditingShortcode(null)
  }, [editing, toast])

  // Bulk file upload — handles multiple files at once
  const handleBulkUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0 || !editing) return

    const fileList = Array.from(files)
    setUploadProgress({ done: 0, total: fileList.length })

    let successCount = 0
    const newEmojis: CustomEmoji[] = []

    for (const file of fileList) {
      try {
        const tags = await uploadFile(file)
        const urlTag = tags.find((t: string[]) => t[0] === 'url')
        if (urlTag?.[1]) {
          // Auto-generate shortcode from filename
          let name = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)
          if (!name) name = `emoji_${Date.now()}`
          // Avoid duplicates — append suffix if needed
          const existingCodes = new Set([...editing.emojis.map(e => e.shortcode), ...newEmojis.map(e => e.shortcode)])
          let finalName = name
          let suffix = 1
          while (existingCodes.has(finalName)) {
            finalName = `${name}_${suffix++}`
          }
          newEmojis.push({ shortcode: finalName, url: urlTag[1] })
          successCount++
        }
      } catch (err) {
        console.warn(`Upload failed for ${file.name}:`, err)
      }
      setUploadProgress(prev => prev ? { ...prev, done: prev.done + 1 } : null)
    }

    if (newEmojis.length > 0) {
      setEditing(prev => prev ? { ...prev, emojis: [...prev.emojis, ...newEmojis] } : prev)
    }

    setUploadProgress(null)
    if (fileInputRef.current) fileInputRef.current.value = ''

    if (successCount > 0) {
      toast({ title: `Uploaded ${successCount}/${fileList.length} files` })
    } else {
      toast({ title: 'All uploads failed', variant: 'destructive' })
    }
  }, [editing, uploadFile, toast])

  const handleAddManualUrl = useCallback(() => {
    if (!manualUrl.trim() || !manualShortcode.trim()) return
    if (!isValidMediaUrl(manualUrl.trim())) return
    const clean = manualShortcode.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)
    if (!clean) return
    addEmojiToSet(clean, manualUrl.trim())
    setManualUrl('')
    setManualShortcode('')
  }, [manualUrl, manualShortcode, addEmojiToSet])

  const _importEmojisFromSet = useCallback((emojis: CustomEmoji[]) => {
    if (!editing) return
    const existingCodes = new Set(editing.emojis.map(e => e.shortcode))
    const toAdd = emojis.filter(e => !existingCodes.has(e.shortcode))
    if (toAdd.length === 0) {
      toast({ title: 'All emojis already in set' })
      return
    }
    setEditing({ ...editing, emojis: [...editing.emojis, ...toAdd] })
    toast({ title: `Imported ${toAdd.length} emojis` })
  }, [editing, toast])

  const handleSave = useCallback(async () => {
    if (!editing || !user) return
    if (!editing.name.trim()) {
      toast({ title: 'Name required', description: 'Give your emoji set a name', variant: 'destructive' })
      return
    }
    if (editing.emojis.length === 0) {
      toast({ title: 'Empty set', description: 'Add at least one emoji', variant: 'destructive' })
      return
    }

    setIsSaving(true)
    try {
      const tags: string[][] = [
        ['d', editing.dTag],
        ['title', editing.name.trim()],
      ]
      for (const emoji of editing.emojis) {
        tags.push(['emoji', emoji.shortcode, emoji.url])
      }
      await publish({ kind: 30030, content: '', tags } as never)
      toast({ title: 'Published', description: `"${editing.name}" — ${editing.emojis.length} emojis` })
      queryClient.invalidateQueries({ queryKey: ['custom-emoji-sets'] })
      setView('list')
      setEditing(null)
    } catch (err) {
      toast({ title: 'Save failed', description: String(err), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }, [editing, user, publish, toast, queryClient])

  const handleDelete = useCallback(async () => {
    if (!editing || !user) return
    setIsDeleting(true)
    try {
      await publish({ kind: 30030, content: '', tags: [['d', editing.dTag]] } as never)
      toast({ title: 'Deleted' })
      queryClient.invalidateQueries({ queryKey: ['custom-emoji-sets'] })
      setView('list')
      setEditing(null)
    } catch (err) {
      toast({ title: 'Delete failed', description: String(err), variant: 'destructive' })
    } finally {
      setIsDeleting(false)
    }
  }, [editing, user, publish, toast, queryClient])

  const duplicateSet = useCallback((set: EmojiSet) => {
    setEditing({
      dTag: `emoji-${Date.now()}`,
      name: `${set.name} (copy)`,
      emojis: [...set.emojis],
      isNew: true,
    })
    setView('edit')
  }, [])

  // ---- Render ----

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // ---- Favorites view ----
  if (view === 'favorites') {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setView('list')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h3 className="font-medium">Emoji Favorites</h3>
        </div>

        <p className="text-xs text-muted-foreground">
          Your most-used emojis appear here automatically when you use them in posts.
        </p>

        {favorites.length > 0 ? (
          <Card className="p-3">
            <p className="text-xs text-muted-foreground mb-2">Top used ({favorites.length})</p>
            <div className="grid grid-cols-8 gap-1">
              {favorites.map((emoji, i) => (
                <span key={`${emoji}-${i}`} className="text-xl h-8 w-8 flex items-center justify-center">
                  {emoji}
                </span>
              ))}
            </div>
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-8">
            No favorites yet. Use emojis in your posts and they'll appear here automatically.
          </p>
        )}
      </div>
    )
  }

  // ---- Browse public sets ----
  if (view === 'browse') {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => { setView(editing ? 'edit' : 'list'); setBrowseQuery('') }}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h3 className="font-medium">Browse Public Emoji Sets</h3>
        </div>

        <div className="flex gap-2">
          <Input
            placeholder="Filter by name or d-tag..."
            value={browseQuery}
            onChange={(e) => setBrowseQuery(e.target.value)}
            className="text-sm"
          />
        </div>

        <ScrollArea className="h-[350px]">
          {isBrowsing ? (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : publicSets && publicSets.length > 0 ? (
            <div className="space-y-2">
              {publicSets.map((set, idx) => (
                <Card key={`${set.pubkey}-${set.dTag}-${idx}`} className="p-3">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{set.name}</p>
                      <p className="text-[10px] text-muted-foreground font-mono truncate">{set.pubkey.slice(0, 12)}...</p>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {editing ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1"
                          onClick={async () => {
                            // Fork as a new saved set (goes to My Sets), not into the build panel
                            try {
                              const dTag = `emoji-${Date.now()}`
                              const tags: string[][] = [['d', dTag], ['title', set.name]]
                              for (const e of set.emojis) tags.push(['emoji', e.shortcode, e.url])
                              await publish({ kind: 30030, content: '', tags } as never)
                              queryClient.invalidateQueries({ queryKey: ['custom-emoji-sets'] })
                              toast({ title: `Saved "${set.name}" to My Sets` })
                            } catch (err) {
                              toast({ title: 'Save failed', description: String(err), variant: 'destructive' })
                            }
                          }}
                        >
                          <Download className="h-3 w-3" />
                          Save to My Sets
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1"
                          onClick={() => {
                            setEditing({
                              dTag: `emoji-${Date.now()}`,
                              name: `${set.name} (copy)`,
                              emojis: [...set.emojis],
                              isNew: true,
                            })
                            setView('edit')
                          }}
                        >
                          <Copy className="h-3 w-3" />
                          Fork
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    {set.emojis.slice(0, 12).map((e) => (
                      <img
                        key={e.shortcode}
                        src={e.url}
                        alt={e.shortcode}
                        title={`:${e.shortcode}:`}
                        className="h-8 w-8 object-contain rounded"
                        loading="lazy"
                      />
                    ))}
                    {set.emojis.length > 12 && (
                      <span className="text-xs text-muted-foreground self-center ml-1">+{set.emojis.length - 12}</span>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <p className="text-center text-sm text-muted-foreground p-8">
              {browseQuery.trim() ? 'No sets found' : 'No public emoji sets found on your relays'}
            </p>
          )}
        </ScrollArea>
      </div>
    )
  }

  // ---- Edit view ----
  if (view === 'edit' && editing) {
    const isGif = (url: string) => url.endsWith('.gif') || url.includes('.gif?')

    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => { setView('list'); setEditing(null) }}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h3 className="font-medium">{editing.isNew ? 'New Emoji Set' : 'Edit Emoji Set'}</h3>
        </div>

        <Input
          placeholder="Set name (e.g. Reaction GIFs, My Stickers)"
          value={editing.name}
          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          className="text-sm"
          autoFocus={editing.isNew}
        />

        {/* Current emojis in the set */}
        {editing.emojis.length > 0 && (
          <Card className="p-2">
            <p className="text-xs text-muted-foreground mb-2">{editing.emojis.length} emojis</p>
            <ScrollArea className={editing.emojis.length > 12 ? 'h-[250px]' : ''}>
              <div className="space-y-1">
                {editing.emojis.map((emoji, idx) => (
                  <div
                    key={emoji.shortcode}
                    className="flex items-center gap-2 p-1.5 rounded hover:bg-muted/50 transition-colors group"
                  >
                    <img
                      src={emoji.url}
                      alt={`:${emoji.shortcode}:`}
                      className={`object-contain rounded ${isGif(emoji.url) ? 'h-16 w-16' : 'h-8 w-8'}`}
                      loading="lazy"
                    />
                    {editingShortcode === emoji.shortcode ? (
                      <div className="flex-1 flex items-center gap-1">
                        <Input
                          value={editingShortcodeValue}
                          onChange={(e) => setEditingShortcodeValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); renameEmoji(emoji.shortcode, editingShortcodeValue) }
                            if (e.key === 'Escape') setEditingShortcode(null)
                          }}
                          className="h-6 text-xs font-mono flex-1"
                          autoFocus
                        />
                        <button type="button" onClick={() => renameEmoji(emoji.shortcode, editingShortcodeValue)} className="text-green-500 hover:text-green-400">
                          <Check className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        className="flex-1 text-left text-xs font-mono text-muted-foreground hover:text-foreground truncate flex items-center gap-1"
                        onClick={() => { setEditingShortcode(emoji.shortcode); setEditingShortcodeValue(emoji.shortcode) }}
                        title="Click to rename"
                      >
                        :{emoji.shortcode}:
                        <Pencil className="h-2.5 w-2.5 opacity-0 group-hover:opacity-50" />
                      </button>
                    )}
                    <div className="flex gap-0.5 shrink-0">
                      <button
                        onClick={() => moveEmoji(emoji.shortcode, 'up')}
                        className="h-5 w-5 flex items-center justify-center rounded hover:bg-muted text-muted-foreground opacity-50 hover:opacity-100 transition-opacity"
                        disabled={idx === 0}
                      >
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => moveEmoji(emoji.shortcode, 'down')}
                        className="h-5 w-5 flex items-center justify-center rounded hover:bg-muted text-muted-foreground opacity-50 hover:opacity-100 transition-opacity"
                        disabled={idx === editing.emojis.length - 1}
                      >
                        <ArrowDown className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => removeEmojiFromSet(emoji.shortcode)}
                        className="h-5 w-5 flex items-center justify-center rounded hover:bg-red-500/20 text-red-400"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </Card>
        )}

        {/* Upload progress */}
        {uploadProgress && (
          <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-muted/50 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Uploading {uploadProgress.done}/{uploadProgress.total}...
          </div>
        )}

        {/* Add emojis — toolbar */}
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={!!uploadProgress}
            className="gap-1 text-xs h-7"
          >
            {uploadProgress ? <Loader2 className="h-3 w-3 animate-spin" /> : <ImagePlus className="h-3 w-3" />}
            Upload
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.gif"
            multiple
            onChange={handleBulkUpload}
            className="hidden"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setActivePanel(activePanel === 'emoji' ? null : 'emoji')}
            className={`gap-1 text-xs h-7 ${activePanel === 'emoji' ? 'ring-2 ring-purple-400' : ''}`}
          >
            <Smile className="h-3 w-3" />
            Emoji
          </Button>
          {sets.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setActivePanel(activePanel === 'mysets' ? null : 'mysets')}
              className={`gap-1 text-xs h-7 ${activePanel === 'mysets' ? 'ring-2 ring-purple-400' : ''}`}
            >
              <Palette className="h-3 w-3" />
              My Sets
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setView('browse')}
            className="gap-1 text-xs h-7"
          >
            <Search className="h-3 w-3" />
            Browse
          </Button>
        </div>

        {/* Standard emoji picker panel */}
        {activePanel === 'emoji' && (
          <Card className="p-2">
            <div className="flex gap-0.5 overflow-x-auto pb-1">
              {EMOJI_CATEGORIES.map((cat, i) => (
                <button
                  key={cat.name}
                  onClick={() => setEmojiCategory(i)}
                  className={`text-base px-1 rounded transition-colors shrink-0 ${emojiCategory === i ? 'bg-muted' : 'hover:bg-muted/50'}`}
                  title={cat.name}
                >
                  {cat.icon}
                </button>
              ))}
            </div>
            <ScrollArea className="h-[150px]">
              <div className="grid grid-cols-8 gap-0.5 pt-1">
                {EMOJI_CATEGORIES[emojiCategory]?.emojis.map((emoji, i) => (
                  <button
                    key={`${emoji}-${i}`}
                    onClick={() => {
                      const codepoints = [...emoji].map(c => c.codePointAt(0)!.toString(16)).join('-').replace(/-fe0f/g, '')
                      const url = `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${codepoints}.png`
                      addEmojiToSet(`emoji_${codepoints}`, url)
                    }}
                    className="text-xl h-8 w-8 flex items-center justify-center rounded hover:bg-muted transition-colors"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </ScrollArea>
          </Card>
        )}

        {/* My Sets picker panel */}
        {activePanel === 'mysets' && sets.length > 0 && (() => {
          // Filter out the set being edited
          const availableSets = sets.filter(s => s.dTag !== editing.dTag)
          if (availableSets.length === 0) return (
            <Card className="p-3 text-center text-xs text-muted-foreground">No other sets to pick from</Card>
          )
          const safeTab = Math.min(mySetsTab, availableSets.length - 1)
          const activeSet = availableSets[safeTab]
          return (
            <Card className="p-2">
              {availableSets.length > 1 && (
                <div className="flex gap-1 overflow-x-auto pb-1 mb-1">
                  {availableSets.map((s, i) => (
                    <button
                      key={s.dTag}
                      onClick={() => setMySetsTab(i)}
                      className={`text-xs px-2 py-0.5 rounded whitespace-nowrap transition-colors shrink-0 ${safeTab === i ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300' : 'hover:bg-muted'}`}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
              <ScrollArea className="h-[150px]">
                <div className="grid grid-cols-6 gap-1">
                  {activeSet?.emojis.map((e) => {
                    const alreadyAdded = editing.emojis.some(ex => ex.shortcode === e.shortcode)
                    return (
                      <button
                        key={e.shortcode}
                        onClick={() => { if (!alreadyAdded) addEmojiToSet(e.shortcode, e.url) }}
                        disabled={alreadyAdded}
                        className={`flex flex-col items-center gap-0.5 p-1 rounded transition-colors ${alreadyAdded ? 'opacity-30' : 'hover:bg-muted'}`}
                        title={alreadyAdded ? 'Already in set' : `:${e.shortcode}:`}
                      >
                        <img src={e.url} alt={e.shortcode} className="h-8 w-8 object-contain" loading="lazy" referrerPolicy="no-referrer" />
                        <span className="text-[9px] text-muted-foreground truncate max-w-full">{e.shortcode}</span>
                      </button>
                    )
                  })}
                </div>
              </ScrollArea>
            </Card>
          )
        })()}

        {/* Manual URL input */}
        <div className="flex gap-1.5">
          <Input
            placeholder="shortcode"
            value={manualShortcode}
            onChange={(e) => setManualShortcode(e.target.value)}
            className="h-7 text-xs w-24 font-mono"
          />
          <Input
            placeholder="Paste image or GIF URL..."
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddManualUrl() } }}
            className="h-7 text-xs flex-1"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={handleAddManualUrl}
            disabled={!manualUrl.trim() || !manualShortcode.trim()}
            className="h-7 text-xs px-2"
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>

        {/* Save / Delete */}
        <div className="flex gap-2 pt-1">
          <Button onClick={handleSave} disabled={isSaving} className="flex-1 bg-purple-600 hover:bg-purple-700">
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
            {editing.isNew ? 'Publish Set' : 'Save Changes'}
          </Button>
          {!editing.isNew && (
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting} title="Delete set">
              {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </Button>
          )}
        </div>
      </div>
    )
  }

  // ---- List view (default) ----
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Custom Emoji Sets</h3>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setView('browse')} className="gap-1">
            <Search className="h-3 w-3" />
            Browse
          </Button>
          <Button size="sm" onClick={startNewSet} className="gap-1">
            <Plus className="h-3 w-3" />
            New Set
          </Button>
        </div>
      </div>

      {/* Favorites */}
      <Card
        className="p-3 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setView('favorites')}
      >
        <div className="flex items-center gap-2">
          <Star className="h-4 w-4 text-yellow-500" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Favorites</p>
            <p className="text-xs text-muted-foreground">
              {favorites.length > 0
                ? `${favorites.length} frequently used`
                : 'Auto-tracked from usage'}
            </p>
          </div>
          {favorites.length > 0 && (
            <div className="flex gap-0.5">
              {favorites.slice(0, 5).map((e, i) => (
                <span key={i} className="text-sm">{e}</span>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Delete confirmation */}
      {confirmDeleteSet && (
        <Card className="p-3 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30">
          <p className="text-sm font-medium mb-1">
            {confirmDeleteSet.pubkey === user?.pubkey
              ? `You created "${confirmDeleteSet.name}". Deleting will remove it from Nostr for everyone.`
              : `Remove "${confirmDeleteSet.name}" from your collection?`}
          </p>
          <div className="flex gap-2 mt-2">
            <Button size="sm" variant="outline" onClick={() => setConfirmDeleteSet(null)} disabled={isDeletingFromList}>Cancel</Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => handleDeleteFromList(confirmDeleteSet)}
              disabled={isDeletingFromList}
            >
              {isDeletingFromList ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Trash2 className="h-3 w-3 mr-1" />}
              {confirmDeleteSet.pubkey === user?.pubkey ? 'Delete from Nostr' : 'Remove'}
            </Button>
          </div>
        </Card>
      )}

      {/* Existing sets (filter out built-in) */}
      {(() => {
        const manageable = sets.filter(s => s.pubkey !== 'built-in')
        return manageable.length === 0 ? (
          <div className="text-center py-6 space-y-2">
            <p className="text-sm text-muted-foreground">No custom emoji sets yet.</p>
            <p className="text-xs text-muted-foreground">Create a set and upload images or GIFs, or browse public sets from other Nostr users.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {manageable.map((set) => {
              const isOwned = set.pubkey === user?.pubkey
              return (
                <Card key={`${set.pubkey}:${set.dTag}`} className={`p-3 group ${isOwned ? 'border-purple-300 dark:border-purple-700' : ''}`}>
                  <div className="flex items-center gap-2">
                    <div
                      className="flex-1 min-w-0 cursor-pointer"
                      onClick={() => isOwned ? startEditSet(set) : duplicateSet(set)}
                    >
                      <div className="flex items-center gap-1.5">
                        <p className={`text-sm font-medium ${isOwned ? 'text-purple-700 dark:text-purple-300' : ''}`}>{set.name}</p>
                        {isOwned ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/50 text-purple-600 dark:text-purple-400">Your set</span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">Saved</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{set.emojis.length} emojis</p>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {set.emojis.slice(0, 4).map((e) => (
                        <img
                          key={e.shortcode}
                          src={e.url}
                          alt={e.shortcode}
                          className="h-6 w-6 object-contain"
                          loading="lazy"
                        />
                      ))}
                      {set.emojis.length > 4 && (
                        <span className="text-xs text-muted-foreground self-center">+{set.emojis.length - 4}</span>
                      )}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); duplicateSet(set) }}
                      className="opacity-50 hover:opacity-100 transition-opacity"
                      title="Duplicate set"
                    >
                      <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmDeleteSet(set) }}
                      className="opacity-50 hover:opacity-100 transition-opacity"
                      title={isOwned ? 'Delete set' : 'Remove from collection'}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-red-500" />
                    </button>
                  </div>
                </Card>
              )
            })}
          </div>
        )
      })()}
    </div>
  )
}
