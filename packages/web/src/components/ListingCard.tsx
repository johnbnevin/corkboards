/**
 * ListingCard — renders a NIP-99 classified listing (kind 30402) with the Gamma
 * Markets extensions (the Open Markets / OpenMarkets crew's recommended spec).
 *
 * Reuses the existing note-rendering wheel: structured fields come from tags via
 * @core/nip99, and the description body is delegated to NoteContent (markdown,
 * media, mentions). This is the building block a future "store" corkboard reuses
 * to show a merchant's listings — see the store-corkboard project note.
 */
import type { NostrEvent } from '@nostrify/nostrify'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MediaLink } from './MediaLink'
import { NoteContent } from './NoteContent'
import { parseListing } from '@core/nip99'
import { MapPin } from 'lucide-react'

interface ListingCardProps {
  event: NostrEvent
  className?: string
  inModalContext?: boolean
  onViewThread?: (eventId: string) => void
  blurMedia?: boolean
  /** Render without the outer Card wrapper (for embedding inside another card). */
  bare?: boolean
}

export function ListingCard({ event, className, inModalContext, onViewThread, blurMedia, bare }: ListingCardProps) {
  const { title, summary, price, images, location, status, visibility, stock, specs } = parseListing(event)
  const isSold = status === 'sold'
  const outOfStock = stock === 0

  const body = (
    <>
      {images[0] && (
        <div className="relative mb-2">
          <MediaLink url={images[0]} blurMedia={blurMedia} />
          {(isSold || outOfStock) && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/60">
              <Badge variant="destructive" className="text-sm">{isSold ? 'Sold' : 'Out of stock'}</Badge>
            </div>
          )}
          {images.length > 1 && (
            <Badge variant="secondary" className="absolute bottom-1 right-1 text-[10px]">+{images.length - 1}</Badge>
          )}
        </div>
      )}
      <div className="space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <div className="font-semibold text-sm break-words min-w-0">{title}</div>
          {price && <Badge variant="secondary" className="shrink-0 whitespace-nowrap">{price}</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {visibility === 'pre-order' && <Badge variant="outline" className="text-[10px]">Pre-order</Badge>}
          {visibility === 'hidden' && <Badge variant="outline" className="text-[10px]">Hidden</Badge>}
          {typeof stock === 'number' && stock > 0 && (
            <Badge variant="outline" className="text-[10px]">{stock} in stock</Badge>
          )}
        </div>
        {location && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3 shrink-0" />
            <span className="truncate">{location}</span>
          </div>
        )}
        {summary && <div className="text-sm text-muted-foreground break-words">{summary}</div>}
        {specs.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {specs.slice(0, 6).map(([k, v], i) => (
              <span key={`${k}-${i}`} className="text-[10px] text-muted-foreground bg-muted rounded px-1.5 py-0.5">
                {k}: <span className="text-foreground">{v}</span>
              </span>
            ))}
          </div>
        )}
        {event.content.trim().length > 0 && (
          <NoteContent
            event={event}
            className="text-sm"
            inModalContext={inModalContext}
            onViewThread={onViewThread}
            blurMedia={blurMedia}
          />
        )}
      </div>
    </>
  )

  if (bare) return <div className={className}>{body}</div>

  return (
    <Card className={className}>
      <CardContent className="p-3">{body}</CardContent>
    </Card>
  )
}
