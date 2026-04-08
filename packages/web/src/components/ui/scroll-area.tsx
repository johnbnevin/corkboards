import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Native scroll area with styled scrollbars.
 * Replaces Radix ScrollArea for simplicity and better CSS compatibility.
 */
const ScrollArea = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "overflow-auto",
      // Styled scrollbars
      "scrollbar-thin scrollbar-thumb-rounded",
      "[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar]:h-2",
      "[&::-webkit-scrollbar-track]:bg-transparent",
      "[&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb]:rounded-full",
      "[&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/50",
      className
    )}
    style={{
      scrollbarWidth: 'thin',
      scrollbarColor: 'hsl(var(--border)) transparent',
    }}
    {...props}
  >
    {children}
  </div>
))
ScrollArea.displayName = "ScrollArea"

// ScrollBar is no longer needed with native scrolling, but export a no-op for compatibility
const ScrollBar = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { orientation?: "vertical" | "horizontal" }
// eslint-disable-next-line @typescript-eslint/no-unused-vars
>(({ className, orientation = "vertical", ...props }, ref) => null)
ScrollBar.displayName = "ScrollBar"

export { ScrollArea, ScrollBar }
