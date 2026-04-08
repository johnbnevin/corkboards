import * as React from "react"
import { Link as RouterLink } from "react-router-dom"
import { cn } from "@/lib/utils"

export interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string
}

const Link = React.forwardRef<HTMLAnchorElement, LinkProps>(
  ({ className, href, children, ...props }, ref) => {
    // External links
    if (href.startsWith('http://') || href.startsWith('https://')) {
      return (
        <a
          ref={ref}
          href={href}
          className={cn("text-primary underline-offset-4 hover:underline", className)}
          target="_blank"
          rel="noopener noreferrer"
          {...props}
        >
          {children}
        </a>
      )
    }

    // Internal links
    return (
      <RouterLink
        ref={ref}
        to={href}
        className={cn("text-primary underline-offset-4 hover:underline", className)}
        {...props}
      >
        {children}
      </RouterLink>
    )
  }
)
Link.displayName = "Link"

export { Link }
