/**
 * BrandIcon — the square Corkboards ("Corky") pin icon (same art as the
 * favicon). Use for the small header/pin spots where the wide wordmark
 * (BrandLogo) doesn't fit. ?v= busts caches; bump it when the art changes.
 */
export function BrandIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <img
      src="/Corkboards-favicon.png?v=5"
      alt="Corkboards"
      className={className}
      draggable={false}
    />
  )
}
