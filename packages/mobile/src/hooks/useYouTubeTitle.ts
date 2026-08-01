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
import { useQuery } from '@tanstack/react-query';
import { fetchYouTubeOembed, getTitleProxyTemplate } from '@core/titleProxy';

export function useYouTubeTitle(videoUrl: string, enabled: boolean) {
  const { data } = useQuery({
    queryKey: ['yt-oembed', videoUrl],
    queryFn: () => fetchYouTubeOembed(videoUrl),
    enabled: enabled && getTitleProxyTemplate() !== null,
    // Titles are static; a failed lookup is not worth retry traffic — the
    // bar simply shows no title.
    staleTime: Infinity,
    gcTime: 24 * 60 * 60 * 1000,
    retry: false,
  });
  return data ?? null;
}
