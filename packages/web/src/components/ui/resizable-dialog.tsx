import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X, Maximize2, Minimize2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { idbGetSync, idbSetSync, idbSet } from "@/lib/idb"

const ResizableDialog = DialogPrimitive.Root
const ResizableDialogTrigger = DialogPrimitive.Trigger
const ResizableDialogPortal = DialogPrimitive.Portal
const ResizableDialogClose = DialogPrimitive.Close

const ResizableDialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
ResizableDialogOverlay.displayName = "ResizableDialogOverlay"

interface ResizableDialogContentProps
  extends Omit<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, 'title'> {
  defaultWidth?: number
  defaultHeight?: number
  minWidth?: number
  minHeight?: number
  dialogTitle?: React.ReactNode
  dialogDescription?: string
  headerExtra?: React.ReactNode
  storageKey?: string
}

const ResizableDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  ResizableDialogContentProps
>(({
  className,
  children,
  defaultWidth = 600,
  defaultHeight = 500,
  minWidth = 320,
  minHeight = 200,
  dialogTitle,
  dialogDescription,
  headerExtra,
  storageKey,
  ...props
}, ref) => {
  const savedState = React.useMemo(() => {
    if (!storageKey) return null
    try {
      const raw = idbGetSync(storageKey)
      return raw ? JSON.parse(raw) as { x: number; y: number; w: number; h: number } : null
    } catch { return null }
  }, [storageKey])

  const [isMaximized, setIsMaximized] = React.useState(false)
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [size, setSize] = React.useState({
    width: savedState?.w ?? defaultWidth,
    height: savedState?.h ?? defaultHeight,
  })
  const [preMaximizeState, setPreMaximizeState] = React.useState<{
    position: { x: number; y: number }
    size: { width: number; height: number }
  } | null>(null)

  const [isDragging, setIsDragging] = React.useState(false)
  const [isResizing, setIsResizing] = React.useState<string | null>(null)
  const dragStartRef = React.useRef({ x: 0, y: 0, posX: 0, posY: 0 })
  const resizeStartRef = React.useRef({ x: 0, y: 0, width: 0, height: 0, posX: 0, posY: 0 })

  // Center on mount, or auto-maximize on mobile
  const initializedRef = React.useRef(false)
  React.useEffect(() => {
    if (!initializedRef.current) {
      const isMobileViewport = window.innerWidth < 768
      if (isMobileViewport) {
        setPosition({ x: 0, y: 0 })
        setSize({ width: window.innerWidth, height: window.innerHeight })
        setIsMaximized(true)
      } else if (savedState) {
        const x = Math.max(0, Math.min(savedState.x, window.innerWidth - size.width))
        const y = Math.max(0, Math.min(savedState.y, window.innerHeight - size.height))
        setPosition({ x, y })
      } else {
        const x = (window.innerWidth - defaultWidth) / 2
        const y = (window.innerHeight - defaultHeight) / 2
        setPosition({ x: Math.max(0, x), y: Math.max(0, y) })
      }
      initializedRef.current = true
    }
  }, [defaultWidth, defaultHeight, savedState, size.width, size.height])

  // Keep dialog within viewport bounds
  React.useEffect(() => {
    if (isMaximized) return
    const maxX = Math.max(0, window.innerWidth - size.width)
    const maxY = Math.max(0, window.innerHeight - size.height)
    if (position.x > maxX || position.y > maxY) {
      setPosition({
        x: Math.min(position.x, maxX),
        y: Math.min(position.y, maxY)
      })
    }
  }, [size.width, size.height, position.x, position.y, isMaximized])

  // Persist position & size to localStorage
  React.useEffect(() => {
    if (!storageKey || isMaximized || !initializedRef.current) return
    try {
      const json = JSON.stringify({ x: position.x, y: position.y, w: size.width, h: size.height })
      idbSetSync(storageKey, json)
      idbSet(storageKey, json) // async persist to IndexedDB
    } catch { /* ignore */ }
  }, [storageKey, position.x, position.y, size.width, size.height, isMaximized])

  const toggleMaximize = React.useCallback(() => {
    if (isMaximized) {
      if (preMaximizeState) {
        setPosition(preMaximizeState.position)
        setSize(preMaximizeState.size)
      }
      setIsMaximized(false)
    } else {
      setPreMaximizeState({ position, size })
      setPosition({ x: 0, y: 0 })
      setSize({ width: window.innerWidth, height: window.innerHeight })
      setIsMaximized(true)
    }
  }, [isMaximized, position, size, preMaximizeState])

  // Drag handlers
  const handleDragStart = React.useCallback((e: React.MouseEvent) => {
    if (isMaximized) return
    e.preventDefault()
    setIsDragging(true)
    dragStartRef.current = { x: e.clientX, y: e.clientY, posX: position.x, posY: position.y }
  }, [isMaximized, position])

  // Resize handlers
  const handleResizeStart = React.useCallback((e: React.MouseEvent, direction: string) => {
    if (isMaximized) return
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(direction)
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      width: size.width,
      height: size.height,
      posX: position.x,
      posY: position.y
    }
  }, [isMaximized, size, position])

  React.useEffect(() => {
    if (!isDragging && !isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        const dx = e.clientX - dragStartRef.current.x
        const dy = e.clientY - dragStartRef.current.y
        const newX = Math.max(0, Math.min(window.innerWidth - size.width, dragStartRef.current.posX + dx))
        const newY = Math.max(0, Math.min(window.innerHeight - size.height, dragStartRef.current.posY + dy))
        setPosition({ x: newX, y: newY })
      } else if (isResizing) {
        const dx = e.clientX - resizeStartRef.current.x
        const dy = e.clientY - resizeStartRef.current.y
        const start = resizeStartRef.current

        let newWidth = start.width
        let newHeight = start.height
        let newX = start.posX
        let newY = start.posY

        if (isResizing.includes('e')) {
          newWidth = Math.max(minWidth, start.width + dx)
        }
        if (isResizing.includes('w')) {
          const proposedWidth = start.width - dx
          if (proposedWidth >= minWidth) {
            newWidth = proposedWidth
            newX = start.posX + dx
          }
        }
        if (isResizing.includes('s')) {
          newHeight = Math.max(minHeight, start.height + dy)
        }
        if (isResizing.includes('n')) {
          const proposedHeight = start.height - dy
          if (proposedHeight >= minHeight) {
            newHeight = proposedHeight
            newY = start.posY + dy
          }
        }

        setSize({ width: newWidth, height: newHeight })
        setPosition({ x: newX, y: newY })
      }
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      setIsResizing(null)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, isResizing, size.width, size.height, minWidth, minHeight])

  const resizeHandleClass = "absolute z-10"

  return (
    <ResizableDialogPortal>
      <ResizableDialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed z-50 flex flex-col border bg-background shadow-lg rounded-lg overflow-hidden",
          isDragging && "cursor-grabbing",
          className
        )}
        style={{
          left: position.x,
          top: position.y,
          width: size.width,
          height: size.height,
        }}
        onPointerDownOutside={(e) => e.preventDefault()}
        {...props}
      >
        {/* Drag handle / header */}
        <div
          className={cn(
            "flex items-center justify-between px-4 py-2 border-b bg-muted/30 select-none",
            !isMaximized && "cursor-grab"
          )}
          onMouseDown={handleDragStart}
        >
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {dialogTitle && (
              <DialogPrimitive.Title className="text-sm font-semibold truncate">
                {dialogTitle}
              </DialogPrimitive.Title>
            )}
            {dialogDescription && (
              <DialogPrimitive.Description className="sr-only">
                {dialogDescription}
              </DialogPrimitive.Description>
            )}
            {headerExtra}
          </div>
          <div className="flex items-center gap-1 ml-2">
            <button
              type="button"
              onClick={toggleMaximize}
              className="p-1.5 rounded hover:bg-muted transition-colors"
              title={isMaximized ? "Restore" : "Maximize"}
            >
              {isMaximized ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </button>
            <DialogPrimitive.Close className="p-1.5 rounded hover:bg-muted transition-colors">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          {children}
        </div>

        {/* Resize handles */}
        {!isMaximized && (
          <>
            {/* Corners */}
            <div className={cn(resizeHandleClass, "top-0 left-0 w-3 h-3 cursor-nw-resize")} onMouseDown={(e) => handleResizeStart(e, 'nw')} />
            <div className={cn(resizeHandleClass, "top-0 right-0 w-3 h-3 cursor-ne-resize")} onMouseDown={(e) => handleResizeStart(e, 'ne')} />
            <div className={cn(resizeHandleClass, "bottom-0 left-0 w-3 h-3 cursor-sw-resize")} onMouseDown={(e) => handleResizeStart(e, 'sw')} />
            <div className={cn(resizeHandleClass, "bottom-0 right-0 w-3 h-3 cursor-se-resize")} onMouseDown={(e) => handleResizeStart(e, 'se')} />
            {/* Edges */}
            <div className={cn(resizeHandleClass, "top-0 left-3 right-3 h-1 cursor-n-resize")} onMouseDown={(e) => handleResizeStart(e, 'n')} />
            <div className={cn(resizeHandleClass, "bottom-0 left-3 right-3 h-1 cursor-s-resize")} onMouseDown={(e) => handleResizeStart(e, 's')} />
            <div className={cn(resizeHandleClass, "left-0 top-3 bottom-3 w-1 cursor-w-resize")} onMouseDown={(e) => handleResizeStart(e, 'w')} />
            <div className={cn(resizeHandleClass, "right-0 top-3 bottom-3 w-1 cursor-e-resize")} onMouseDown={(e) => handleResizeStart(e, 'e')} />
          </>
        )}
      </DialogPrimitive.Content>
    </ResizableDialogPortal>
  )
})
ResizableDialogContent.displayName = "ResizableDialogContent"

export {
  ResizableDialog,
  ResizableDialogPortal,
  ResizableDialogOverlay,
  ResizableDialogClose,
  ResizableDialogTrigger,
  ResizableDialogContent,
}
