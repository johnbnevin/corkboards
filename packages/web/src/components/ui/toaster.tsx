import { useToast } from "@/hooks/useToast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"

export function Toaster() {
  const { toasts } = useToast()

  return (
    // duration=Infinity: toasts stay until the user closes them (Radix skips
    // its auto-close timer for Infinity). Auto-dismiss meant an error could
    // flash past unread — and an unread error is an error that never happened
    // as far as the user can tell. TOAST_LIMIT=1 keeps this from piling up:
    // a newer toast still replaces the current one.
    <ToastProvider duration={Infinity}>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        return (
          <Toast key={id} {...props}>
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
