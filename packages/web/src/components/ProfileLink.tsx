import { useAuthor } from '@/hooks/useAuthor'
import { nip19 } from 'nostr-tools'
import { Skeleton } from '@/components/ui/skeleton'
import { ClickableProfile } from '@/components/ProfileModal'
import { genUserName } from '@/lib/genUserName'

function getPubkeyFromIdentifier(identifier: string): string {
  try {
    const decoded = nip19.decode(identifier)
    if (decoded.type === 'npub') {
      return decoded.data
    }
    if (decoded.type === 'nprofile') {
      return decoded.data.pubkey
    }
  } catch {
    // Fall through
  }
  return identifier
}

function getDisplayName(metadata: { name?: string; display_name?: string; nip05?: string } | undefined, pubkey: string): string {
  // Try display_name first (preferred)
  if (metadata?.display_name) return metadata.display_name
  // Then name
  if (metadata?.name) return metadata.name
  // Try to extract username from nip05 (e.g., "alice@example.com" -> "alice")
  if (metadata?.nip05) {
    const nip05User = metadata.nip05.split('@')[0]
    if (nip05User && nip05User !== '_') return nip05User
  }
  // Generate a friendly fallback name
  return genUserName(pubkey)
}

export function ProfileLink({ pubkey }: { pubkey: string }) {
  const resolvedPubkey = getPubkeyFromIdentifier(pubkey)
  const { data: author, isLoading } = useAuthor(resolvedPubkey)

  const profileName = getDisplayName(author?.metadata, resolvedPubkey)
  const hasRealName = !!(author?.metadata?.display_name || author?.metadata?.name)

  if (isLoading) {
    return <Skeleton className="h-4 w-[100px] inline-block align-middle" />
  }

  return (
    <ClickableProfile
      pubkey={resolvedPubkey}
      className={`font-medium ${hasRealName ? 'text-purple-500 hover:text-purple-600' : 'text-gray-500 hover:text-gray-600'}`}
    >
      @{profileName}
    </ClickableProfile>
  )
}
