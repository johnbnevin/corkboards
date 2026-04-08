import { useState, useRef, useCallback } from 'react'
import { NRelay1 } from '@nostrify/nostrify'
import type { NostrEvent } from '@nostrify/nostrify'
import { nip19 } from 'nostr-tools'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useProfileModal } from '@/components/ProfileModal'
import { SEARCH_RELAY } from '@/lib/relayConstants'

interface SearchResult {
  pubkey: string
  name?: string
  picture?: string
  about?: string
}

export function OnboardSearchWidget({ contactCount = 0, onSkip }: { contactCount?: number; onSkip?: () => void }) {
  const { openProfile } = useProfileModal()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const relayRef = useRef<NRelay1 | null>(null)

  const tryDirectPubkey = useCallback((input: string): string | null => {
    const trimmed = input.trim()
    try {
      const d = nip19.decode(trimmed)
      if (d.type === 'npub') return d.data as string
      if (d.type === 'nprofile') return (d.data as { pubkey: string }).pubkey
    } catch { /* not a valid bech32 */ }
    if (trimmed.length === 64 && /^[a-f0-9]+$/.test(trimmed)) return trimmed
    return null
  }, [])

  const clearSearch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    relayRef.current?.close()
    relayRef.current = null
    setQuery('')
    setResults([])
    setIsSearching(false)
  }, [])

  const handleInput = useCallback((value: string) => {
    setQuery(value)

    if (!value.trim()) {
      setResults([])
      return
    }

    // Direct npub / nprofile / hex pubkey — open profile immediately
    const directPubkey = tryDirectPubkey(value)
    if (directPubkey) {
      openProfile(directPubkey)
      clearSearch()
      return
    }

    // Debounce name search
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (value.trim().length < 2) {
      setResults([])
      return
    }

    debounceRef.current = setTimeout(async () => {
      if (isSearching) {
        relayRef.current?.close()
        relayRef.current = null
      }
      setIsSearching(true)
      try {
        const relay = new NRelay1(SEARCH_RELAY)
        relayRef.current = relay

        const events: NostrEvent[] = []
        const timeout = setTimeout(() => relay.close(), 5000)
        try {
          for await (const msg of relay.req([{ kinds: [0], search: value.trim(), limit: 8 }])) {
            if (msg[0] === 'EVENT') {
              events.push(msg[2] as NostrEvent)
            } else if (msg[0] === 'EOSE') {
              break
            }
          }
        } finally {
          clearTimeout(timeout)
          relay.close()
          relayRef.current = null
        }

        const parsed: SearchResult[] = events.map(e => {
          try {
            const meta = JSON.parse(e.content)
            return {
              pubkey: e.pubkey,
              name: meta.display_name || meta.name,
              picture: meta.picture,
              about: meta.about,
            }
          } catch {
            return { pubkey: e.pubkey }
          }
        })

        setResults(parsed)
      } catch {
        // Search relay unavailable — silently fail
      } finally {
        setIsSearching(false)
      }
    }, 400)
  }, [tryDirectPubkey, openProfile, clearSearch, isSearching])

  const selectResult = useCallback((pubkey: string) => {
    openProfile(pubkey)
    clearSearch()
  }, [openProfile, clearSearch])

  return (
    <div className="mb-4 p-4 rounded-lg border bg-gradient-to-br from-purple-50 to-indigo-50 dark:from-purple-950/20 dark:to-indigo-950/20 border-purple-200 dark:border-purple-800/40">
      <p className="text-sm text-muted-foreground mb-1 leading-relaxed">
        Follow anyone you find interesting. Take your time and curate your experience. Use the orange button below to see more.
      </p>
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-purple-500 transition-all duration-500 rounded-full"
            style={{ width: `${Math.min(contactCount / 10 * 100, 100)}%` }}
          />
        </div>
        <span className="text-xs font-medium text-muted-foreground shrink-0">{contactCount}/10</span>
      </div>
      {onSkip && (
        <p className="text-[10px] text-muted-foreground/50 mb-3 leading-relaxed">
          Already know your way around?{' '}
          <button type="button" onClick={onSkip} className="underline hover:text-foreground transition-colors">Skip onboarding</button>
        </p>
      )}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          className="pl-9 pr-8 bg-background/80"
          placeholder="Find someone by npub or name…"
          value={query}
          onChange={e => handleInput(e.target.value)}
        />
        {query && (
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={clearSearch}
          >
            <X className="h-4 w-4" />
          </button>
        )}

        {/* Results dropdown */}
        {(results.length > 0 || isSearching) && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-background border rounded-md shadow-lg z-50 max-h-64 overflow-auto">
            {isSearching && results.length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">Searching…</div>
            )}
            {results.map(r => (
              <button
                key={r.pubkey}
                className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-accent text-left transition-colors"
                onClick={() => selectResult(r.pubkey)}
              >
                {r.picture ? (
                  <img
                    src={r.picture}
                    alt=""
                    className="h-8 w-8 rounded-full object-cover shrink-0"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
                    {r.name?.charAt(0)?.toUpperCase() ?? '?'}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm truncate">{r.name ?? 'Unknown'}</div>
                  {r.about && (
                    <div className="text-xs text-muted-foreground truncate">{r.about}</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
