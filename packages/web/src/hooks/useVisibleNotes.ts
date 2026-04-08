/**
 * useVisibleNotes
 *
 * Hook that tracks which notes are currently visible in the viewport.
 * Used for performance optimization - only fully hydrate visible notes.
 */
import { useEffect, useRef, useState, useCallback } from 'react';

interface VisibleNotesOptions {
  rootMargin?: string;
  threshold?: number;
}

export function useVisibleNotes(
  noteIds: string[],
  options: VisibleNotesOptions = {}
): {
  visibleIds: Set<string>;
  noteRefs: Map<string, (el: HTMLElement | null) => void>;
} {
  const { rootMargin = '200px', threshold = 0 } = options;
  
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const elementsRef = useRef<Map<string, HTMLElement>>(new Map());
  
  const noteRefs = useCallback((id: string) => {
    return (el: HTMLElement | null) => {
      if (el) {
        elementsRef.current.set(id, el);
      } else {
        elementsRef.current.delete(id);
      }
    };
  }, []);
  
  useEffect(() => {
    if (observerRef.current) {
      observerRef.current.disconnect();
    }
    
    observerRef.current = new IntersectionObserver(
      (entries) => {
        setVisibleIds((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const id = entry.target.getAttribute('data-note-id');
            if (id) {
              if (entry.isIntersecting) {
                next.add(id);
              } else {
                next.delete(id);
              }
            }
          }
          return next;
        });
      },
      { rootMargin, threshold }
    );
    
    for (const [, el] of elementsRef.current) {
      observerRef.current!.observe(el);
    }
    
    return () => {
      observerRef.current?.disconnect();
    };
  }, [noteIds.length, rootMargin, threshold]);
  
  return { visibleIds, noteRefs: new Map(noteIds.map(id => [id, noteRefs(id)])) };
}
