import { useMemo } from 'react'
import { nip19 } from 'nostr-tools'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuthor } from '@/hooks/useAuthor'
import { useNostr } from '@/hooks/useNostr'
import { NoteContent } from '@/components/NoteContent'
import { ProfileAbout } from '@/components/ProfileAbout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertCircle } from 'lucide-react'

// Valid NIP-19 prefixes
const NIP19_PREFIXES = ['npub1', 'note1', 'nprofile1', 'nevent1', 'naddr1', 'nsec1']

export function NIP19Page() {
  const { nip19: identifier } = useParams()

  // Check if it even looks like a NIP-19 identifier
  const isValidPrefix = identifier && NIP19_PREFIXES.some(p => identifier.startsWith(p))

  const decoded = useMemo(() => {
    if (!isValidPrefix) return null
    try {
      return identifier ? nip19.decode(identifier) : null
    } catch {
      return null
    }
  }, [identifier, isValidPrefix])

  // Redirect to home if not a valid NIP-19 identifier
  if (!identifier || !isValidPrefix) {
    // This isn't a NIP-19 route, show 404
    return (
      <Alert variant="destructive" className="max-w-lg mx-auto mt-8">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Page Not Found</AlertTitle>
        <AlertDescription>
          The requested page does not exist. <a href="/" className="underline">Go home</a>
        </AlertDescription>
      </Alert>
    )
  }

  if (!decoded) {
    return (
      <Alert variant="destructive" className="max-w-lg mx-auto mt-8">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Invalid Identifier</AlertTitle>
        <AlertDescription>
          The provided NIP-19 identifier is invalid or unsupported
        </AlertDescription>
      </Alert>
    )
  }

  switch (decoded.type) {
    case 'npub':
    case 'nprofile':
      return <ProfileSection decoded={decoded} />

    case 'note':
    case 'nevent':
      return <EventSection decoded={decoded} />

    case 'naddr':
      return <AddressableSection decoded={decoded} />

    default:
      return (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Unsupported Type</AlertTitle>
          <AlertDescription>
            {decoded.type} identifiers are not currently supported
          </AlertDescription>
        </Alert>
      )
  }
}

function ProfileSection({ decoded }: { decoded: nip19.DecodedResult }) {
  const pubkey = decoded.type === 'npub' ? decoded.data as string : (decoded.data as { pubkey: string }).pubkey
  const author = useAuthor(pubkey)

  if (!author.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto p-4">
      <ProfileAbout about={author.data.metadata?.about} pubkey={pubkey} />
    </div>
  )
}

function EventSection({ decoded }: { decoded: nip19.DecodedResult }) {
  const { nostr } = useNostr()
  const eventId = decoded.type === 'note' ? decoded.data as string : (decoded.data as { id: string }).id

  const eventQuery = useQuery({
    queryKey: ['event', eventId],
    queryFn: async (c) => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(5000)])
      const events = await nostr.query([{ ids: [eventId] }], { signal })
      return events[0]
    },
  })

  if (eventQuery.isLoading) {
    return (
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <Skeleton className="h-12 w-12 rounded-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (!eventQuery.data) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Event Not Found</AlertTitle>
        <AlertDescription>
          The requested event could not be found on connected relays
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="max-w-3xl mx-auto p-4">
      <NoteContent event={eventQuery.data} />
    </div>
  )
}

function AddressableSection({ decoded }: { decoded: nip19.DecodedResult }) {
  const { nostr } = useNostr()
  const { kind, pubkey, identifier } = decoded.data as { kind: number; pubkey: string; identifier: string }

  const addrQuery = useQuery({
    queryKey: ['naddr', kind, pubkey, identifier],
    queryFn: async (c) => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(5000)])
      const events = await nostr.query([{ 
        kinds: [kind],
        authors: [pubkey],
        '#d': [identifier]
      }], { signal })
      return events[0]
    },
  })

  if (addrQuery.isLoading) {
    return (
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <Skeleton className="h-12 w-12 rounded-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!addrQuery.data) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Content Not Found</AlertTitle>
        <AlertDescription>
          The requested resource could not be found on connected relays
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="max-w-3xl mx-auto p-4">
      <NoteContent event={addrQuery.data} />
    </div>
  )
}
