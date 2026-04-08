import * as React from "react"
import * as AvatarPrimitive from "@radix-ui/react-avatar"

import { cn } from "@/lib/utils"
import { useAvatarSizeLimit } from "@/hooks/useImageSizeLimit"

const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex h-10 w-10 shrink-0 overflow-hidden rounded-lg",
      className
    )}
    {...props}
  />
))
Avatar.displayName = AvatarPrimitive.Root.displayName

// HEAD-based size cache shared with SizeGuardedImage
const avatarSizeCache = new Map<string, number | null>()
const avatarPendingChecks = new Map<string, Promise<number | null>>()
// URLs the user chose to load despite being over the size limit
const avatarOverrides = new Set<string>()

function checkAvatarSize(url: string): Promise<number | null> {
  if (avatarSizeCache.has(url)) return Promise.resolve(avatarSizeCache.get(url)!)
  if (avatarPendingChecks.has(url)) return avatarPendingChecks.get(url)!

  const promise = (async () => {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
      const cl = res.headers.get('content-length')
      const size = cl ? parseInt(cl, 10) : null
      avatarSizeCache.set(url, size)
      return size
    } catch {
      avatarSizeCache.set(url, null)
      return null
    } finally {
      avatarPendingChecks.delete(url)
    }
  })()

  avatarPendingChecks.set(url, promise)
  return promise
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, src, ...props }, ref) => {
  const limitBytes = useAvatarSizeLimit()
  const [status, setStatus] = React.useState<'checking' | 'allowed' | 'blocked' | 'override'>('checking')
  const [sizeBytes, setSizeBytes] = React.useState<number | null>(null)

  React.useEffect(() => {
    if (!src || limitBytes === 0 || avatarOverrides.has(src)) {
      setStatus('allowed')
      return
    }
    // Check cache synchronously first
    if (avatarSizeCache.has(src)) {
      const size = avatarSizeCache.get(src)!
      setSizeBytes(size)
      setStatus(size !== null && size > limitBytes ? 'blocked' : 'allowed')
      return
    }
    // Don't render <img> until HEAD check completes — prevents browser from downloading
    setStatus('checking')
    checkAvatarSize(src).then(size => {
      setSizeBytes(size)
      setStatus(size !== null && size > limitBytes ? 'blocked' : 'allowed')
    })
  }, [src, limitBytes])

  // While checking, render nothing — AvatarFallback will show instead
  if (status === 'checking') return null

  if (status === 'blocked') {
    return (
      <button
        className="flex h-full w-full items-center justify-center rounded-lg bg-muted/80 border border-dashed border-orange-400/60 cursor-pointer hover:bg-muted transition-colors"
        title={`Avatar blocked (${sizeBytes ? formatBytes(sizeBytes) : 'unknown size'}) — click to load`}
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          if (src) avatarOverrides.add(src)
          setStatus('override')
        }}
      >
        <span className="text-[7px] leading-tight text-center text-orange-500 font-medium px-0.5">
          {sizeBytes ? formatBytes(sizeBytes) : '?'}
        </span>
      </button>
    )
  }

  return (
    <AvatarPrimitive.Image
      ref={ref}
      className={cn("aspect-square h-full w-full object-cover", className)}
      loading="lazy"
      decoding="async"
      src={src}
      {...props}
    />
  )
})
AvatarImage.displayName = AvatarPrimitive.Image.displayName

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      "flex h-full w-full items-center justify-center rounded-lg bg-muted",
      className
    )}
    {...props}
  />
))
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName

export { Avatar, AvatarImage, AvatarFallback }
