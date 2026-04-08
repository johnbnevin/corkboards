import { Card, CardContent } from '@/components/ui/card'
import { ExternalLink } from 'lucide-react'

function isSafeUrl(url: string): boolean {
  const lower = url.trim().toLowerCase()
  return lower.startsWith('http://') || lower.startsWith('https://')
}

export function WebLink({ url }: { url: string }) {
  let hostname = ''
  try {
    hostname = new URL(url).hostname
  } catch {
    hostname = url
  }

  if (!isSafeUrl(url)) {
    return <span className="text-muted-foreground text-sm break-all">{url}</span>
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block mb-2" onClick={(e) => e.stopPropagation()}>
      <Card className="hover:bg-accent transition-colors">
        <CardContent className="p-3 flex items-center gap-2">
          <ExternalLink className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-sm truncate">{hostname}</div>
            <div className="text-xs text-muted-foreground truncate">{url}</div>
          </div>
        </CardContent>
      </Card>
    </a>
  )
}
