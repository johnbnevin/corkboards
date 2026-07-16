import { createContext, useContext } from 'react';

/**
 * Lets deeply-nested content (NoteContent) trigger a hashtag action owned by
 * HomeScreen — the "open in a new corkboard?" prompt — without threading
 * callbacks through every component. Mirrors the web context of the same name.
 * When no provider is present, hashtags render as inert text.
 */
export interface HashtagAction {
  /** Called with the bare hashtag (no leading '#'). */
  onHashtagClick: (tag: string) => void;
}

export const HashtagActionContext = createContext<HashtagAction | null>(null);

export function useHashtagAction(): HashtagAction | null {
  return useContext(HashtagActionContext);
}
