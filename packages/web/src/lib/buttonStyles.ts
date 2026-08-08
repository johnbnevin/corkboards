/**
 * Shared styling for the "light pill" controls in the top tab bar and bottom
 * status bar.
 *
 * These stay white with dark text in BOTH themes — a deliberate design choice
 * for dark mode. Two things live here so they can't drift per-copy again:
 *
 * - `hover:text-gray-900`: the shadcn outline/ghost variants apply
 *   `hover:text-accent-foreground`, which is near-white in dark mode — on the
 *   gray-100 hover background the label effectively vanished. The explicit
 *   override keeps hovered text dark everywhere.
 * - This string was previously copy-pasted ~20 times across StatusBar and
 *   TabBar; every restyle had to hit every copy.
 */
export const LIGHT_BTN =
  'bg-white border-gray-300 text-gray-700 hover:bg-gray-100 hover:text-gray-900';

/** Inactive tab trigger in the desktop TabBar — light pill plus the purple
 *  active state. Kept next to LIGHT_BTN for the same anti-drift reason. */
export const TAB_TRIGGER_CLS =
  'flex items-center gap-1 h-5 px-2 text-xs border border-gray-300 bg-white text-gray-700 rounded-md data-[state=active]:bg-purple-600 data-[state=active]:text-white data-[state=active]:border-purple-600';
