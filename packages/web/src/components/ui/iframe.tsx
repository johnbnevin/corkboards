import * as React from "react"
import { cn } from "@/lib/utils"

export type IframeProps = React.IframeHTMLAttributes<HTMLIFrameElement>

/**
 * Secure iframe component with privacy and security defaults.
 * - sandbox: restricts iframe capabilities
 * - referrerpolicy: prevents leaking referrer info
 * - loading: lazy loads for performance
 */
const Iframe = React.forwardRef<HTMLIFrameElement, IframeProps>(
  ({ className, title = "Embedded content", sandbox, referrerPolicy, ...props }, ref) => {
    return (
      <iframe
        ref={ref}
        title={title}
        className={cn("border-0", className)}
        loading="lazy"
        // Security: restrict iframe capabilities by default — allow-scripts must be opted in by caller
        sandbox={sandbox ?? "allow-popups allow-presentation"}
        // Privacy: don't leak referrer information
        referrerPolicy={referrerPolicy ?? "no-referrer"}
        {...props}
      />
    )
  }
)
Iframe.displayName = "Iframe"

export { Iframe }
