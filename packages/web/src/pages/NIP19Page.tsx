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
import { fetchEventWithOutbox } from '@/lib/fetchEvent'
import { AlertCircle, ShieldAlert } from 'lucide-react'

// Valid NIP-19 prefixes. `nsec1` is listed so we can RECOGNIZE one and warn —
// never to render it. See the nsec branch below.
const NIP19_PREFIXES = ['npub1', 'note1', 'nprofile1', 'nevent1', 'naddr1', 'nsec1']

export function NIP19Page() {
  const { nip19: identifier } = useParams()

  // Check if it even looks like a NIP-19 identifier
  const isValidPrefix = identifier && NIP19_PREFIXES.some(p => identifier.startsWith(p))

  // A secret key in the address bar is already an incident: it is in this
  // browser's history, in any extension reading the URL, and in the referrer of
  // the next outbound link. Never decode it, never echo it back on screen, and
  // never let the user assume it is still theirs alone.
  const isNsec = !!identifier?.startsWith('nsec1')

  const decoded = useMemo(() => {
    if (!isValidPrefix || isNsec) return null
    try {
      return identifier ? nip19.decode(identifier) : null
    } catch {
      return null
    }
  }, [identifier, isValidPrefix, isNsec])

  if (isNsec) {
    return (
      <Alert variant="destructive" className="max-w-lg mx-auto mt-8">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>That is a PRIVATE key — treat it as compromised</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>
            An <code>nsec</code> is the secret key to a Nostr identity, not a link.
            This one has been in a URL, so assume it is already in your browser
            history, in every extension that can read the address bar, and in the
            server logs of anywhere that link came from.
          </p>
          <p>
            <strong>Anyone holding it can post as you, forever. It cannot be
            changed or revoked.</strong> If it is your key, generate a new identity
            and stop using this one. If someone sent it to you, they made a serious
            mistake — tell them.
          </p>
          <p>
            We have not decoded it, stored it, or sent it anywhere.{' '}
            <a href="/" className="underline">Go home</a>
          </p>
        </AlertDescription>
      </Alert>
    )
  }

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
  const isNevent = decoded.type === 'nevent'
  const eventId = decoded.type === 'note' ? decoded.data as string : (decoded.data as { id: string }).id
  // An nevent carries the relay hints and author the sharer knew about. Querying
  // only the default pool threw those away, so a note that lives on the author's
  // own relays rendered as "Event Not Found" even though the link said exactly
  // where to look. Outbox routing uses both.
  const eventRelays = isNevent ? (decoded.data as { relays?: string[] }).relays : undefined
  const eventAuthor = isNevent ? (decoded.data as { author?: string }).author : undefined

  const eventQuery = useQuery({
    queryKey: ['event', eventId, eventRelays?.join(',') ?? '', eventAuthor ?? ''],
    queryFn: () => fetchEventWithOutbox(eventId, nostr, {
      hints: eventRelays,
      authorPubkey: eventAuthor,
    }),
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
