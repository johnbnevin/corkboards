import { createContext, useContext } from 'react';

/**
 * Lets deeply-nested content (NoteContent) trigger a hashtag action owned by
 * MultiColumnClient — namely the "open in a new corkboard?" prompt — without
 * threading callbacks through every intermediate component. When no provider is
 * present (e.g. NoteContent rendered outside the main client), consumers fall
 * back to plain /t/:hashtag navigation.
 */
export interface HashtagAction {
  /** Called with the bare hashtag (no leading '#'). */
  onHashtagClick: (tag: string) => void;
}

export const HashtagActionContext = createContext<HashtagAction | null>(null);

export function useHashtagAction(): HashtagAction | null {
  return useContext(HashtagActionContext);
}
