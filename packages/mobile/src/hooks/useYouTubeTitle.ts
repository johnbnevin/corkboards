/**
 * useYouTubeTitle — video title for the YouTube external-open bar, fetched
 * via the USER-configured title proxy (@core/titleProxy). Mirror of web.
 *
 * Fires nothing at all — `enabled: false` — unless BOTH hold:
 *   1. the caller says a YouTube bar is actually rendered, and
 *   2. the user has configured a title-proxy template.
 * So with the default (blank) setting this hook is inert and no request
 * reaches any provider until the user opts in.
 */
import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchYouTubeOembed, getTitleProxyTemplate, subscribeTitleProxy } from '@core/titleProxy';

export function useYouTubeTitle(videoUrl: string, enabled: boolean) {
  // Subscribe so bars already on screen light up the moment the user enables
  // titles in settings — a plain getTitleProxyTemplate() read was captured at
  // render time and stayed false until a remount. (Parity with web.)
  const template = useSyncExternalStore(subscribeTitleProxy, getTitleProxyTemplate);
  const { data } = useQuery({
    queryKey: ['yt-oembed', videoUrl],
    queryFn: () => fetchYouTubeOembed(videoUrl),
    enabled: enabled && template !== null,
    // Titles are static; a failed lookup is not worth retry traffic — the
    // bar simply shows no title.
    staleTime: Infinity,
    gcTime: 24 * 60 * 60 * 1000,
    retry: false,
  });
  return data ?? null;
}
