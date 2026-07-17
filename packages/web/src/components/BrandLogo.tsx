/**
 * BrandLogo — the Corkboards ("Corky") wordmark logo. Served from public/ so it
 * ships with dist / dist_stage / releases. Use in place of the old
 * "📌 corkboards.me" text branding across the app (login, splash, etc.).
 */
export function BrandLogo({ className = 'h-10 w-auto' }: { className?: string }) {
  return (
    <img
      src="/Corkboards-Logo-Corky.png"
      alt="Corkboards"
      className={className}
      draggable={false}
    />
  )
}
