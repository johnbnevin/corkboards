/**
 * BrandLogo — the Corkboards ("Corky") wordmark logo. Served from public/ so it
 * ships with dist / dist_stage / releases. Use in place of the old
 * "📌 corkboards.me" text branding across the app (login, splash, etc.).
 */
export function BrandLogo({ className = 'h-10 w-auto' }: { className?: string }) {
  return (
    <img
      // ?v= busts the service-worker/browser cache for the stable filename —
      // bump this whenever the logo art changes so users get the new version.
      src="/Corkboards-Logo-Corky.png?v=2"
      alt="Corkboards"
      className={className}
      draggable={false}
    />
  )
}
