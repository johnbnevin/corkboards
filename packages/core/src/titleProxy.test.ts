import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  validateTitleProxyTemplate,
  setTitleProxyTemplate,
  getTitleProxyTemplate,
  buildYouTubeOembedUrl,
  applyTitleProxy,
  fetchYouTubeOembed,
  CORKBOARDS_TITLE_PROXY,
} from './titleProxy';

afterEach(() => setTitleProxyTemplate(null));

describe('validateTitleProxyTemplate', () => {
  it('accepts empty (disabled) and a well-formed https template', () => {
    expect(validateTitleProxyTemplate('')).toBeNull();
    expect(validateTitleProxyTemplate('  ')).toBeNull();
    expect(validateTitleProxyTemplate('https://example.com/p?u={url}')).toBeNull();
  });

  it('accepts a plain https URL without {url} (POST mode)', () => {
    expect(validateTitleProxyTemplate('https://corkboards.me/youtube-proxy.php')).toBeNull();
    expect(validateTitleProxyTemplate(CORKBOARDS_TITLE_PROXY)).toBeNull();
  });

  it('rejects non-https and unparseable plain URLs', () => {
    expect(validateTitleProxyTemplate('http://example.com/p?u={url}')).toMatch(/https/);
    expect(validateTitleProxyTemplate('http://example.com/p')).toMatch(/https/);
    expect(validateTitleProxyTemplate('https://')).toMatch(/valid/);
  });
});

describe('setTitleProxyTemplate', () => {
  it('round-trips a valid template and disables on invalid input', () => {
    setTitleProxyTemplate('https://example.com/p?u={url}');
    expect(getTitleProxyTemplate()).toBe('https://example.com/p?u={url}');
    setTitleProxyTemplate('http://insecure/{url}');
    expect(getTitleProxyTemplate()).toBeNull();
    setTitleProxyTemplate('https://example.com/p?u={url}');
    setTitleProxyTemplate('');
    expect(getTitleProxyTemplate()).toBeNull();
  });
});

describe('buildYouTubeOembedUrl', () => {
  it('accepts YouTube hosts', () => {
    for (const u of [
      'https://www.youtube.com/watch?v=abc123',
      'https://youtube.com/watch?v=abc123',
      'https://m.youtube.com/watch?v=abc123',
      'https://music.youtube.com/watch?v=abc123',
      'https://youtu.be/abc123',
      'https://www.youtube-nocookie.com/embed/abc123',
    ]) {
      expect(buildYouTubeOembedUrl(u)).toBe(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(u)}&format=json`,
      );
    }
  });

  it('rejects non-YouTube and lookalike hosts', () => {
    expect(buildYouTubeOembedUrl('https://example.com/watch?v=abc')).toBeNull();
    expect(buildYouTubeOembedUrl('https://evilyoutube.com/watch?v=abc')).toBeNull();
    expect(buildYouTubeOembedUrl('https://youtube.com.evil.net/watch?v=abc')).toBeNull();
    expect(buildYouTubeOembedUrl('not a url')).toBeNull();
    expect(buildYouTubeOembedUrl('ftp://youtube.com/x')).toBeNull();
  });
});

describe('applyTitleProxy', () => {
  it('returns null with no template — the do-not-fetch signal', () => {
    expect(applyTitleProxy('https://www.youtube.com/oembed?url=x')).toBeNull();
  });

  it('substitutes the encoded oEmbed URL in GET mode', () => {
    setTitleProxyTemplate('https://p.example/f?u={url}');
    const oembed = 'https://www.youtube.com/oembed?url=abc&format=json';
    expect(applyTitleProxy(oembed)).toEqual({
      url: `https://p.example/f?u=${encodeURIComponent(oembed)}`,
      method: 'GET',
    });
  });

  it('returns the bare endpoint with POST for plain-URL templates', () => {
    setTitleProxyTemplate(CORKBOARDS_TITLE_PROXY);
    expect(applyTitleProxy('https://www.youtube.com/oembed?url=x')).toEqual({
      url: CORKBOARDS_TITLE_PROXY,
      method: 'POST',
    });
  });
});

describe('fetchYouTubeOembed', () => {
  const video = 'https://www.youtube.com/watch?v=abc123';

  it('NEVER calls fetch when no template is configured (the privacy invariant)', async () => {
    const fetchFn = vi.fn();
    expect(await fetchYouTubeOembed(video, fetchFn as unknown as typeof fetch)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('never calls fetch for a non-YouTube URL even with a template set', async () => {
    setTitleProxyTemplate('https://p.example/f?u={url}');
    const fetchFn = vi.fn();
    expect(await fetchYouTubeOembed('https://example.com/v', fetchFn as unknown as typeof fetch)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns clamped title/author on success', async () => {
    setTitleProxyTemplate('https://p.example/f?u={url}');
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ title: 'T'.repeat(400), author_name: 'A'.repeat(300) }),
    });
    const info = await fetchYouTubeOembed(video, fetchFn as unknown as typeof fetch);
    expect(info!.title).toHaveLength(300);
    expect(info!.authorName).toHaveLength(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const calledWith = fetchFn.mock.calls[0][0] as string;
    expect(calledWith.startsWith('https://p.example/f?u=')).toBe(true);
  });

  it('POST mode: sends the oEmbed URL in the body, never the query string', async () => {
    setTitleProxyTemplate(CORKBOARDS_TITLE_PROXY);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ title: 'A Video', author_name: 'Someone' }),
    });
    const info = await fetchYouTubeOembed(video, fetchFn as unknown as typeof fetch);
    expect(info).toEqual({ title: 'A Video', authorName: 'Someone' });
    const [calledUrl, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(CORKBOARDS_TITLE_PROXY); // no query string
    expect(init.method).toBe('POST');
    expect(init.body).toBe(`https://www.youtube.com/oembed?url=${encodeURIComponent(video)}&format=json`);
  });

  it('returns null on non-2xx, bad JSON, and missing title', async () => {
    setTitleProxyTemplate('https://p.example/f?u={url}');
    const bad = [
      { ok: false, json: async () => ({}) },
      { ok: true, json: async () => { throw new Error('bad json'); } },
      { ok: true, json: async () => ({ author_name: 'x' }) },
      { ok: true, json: async () => null },
    ];
    for (const res of bad) {
      const fetchFn = vi.fn().mockResolvedValue(res);
      expect(await fetchYouTubeOembed(video, fetchFn as unknown as typeof fetch)).toBeNull();
    }
  });

  it('returns null when fetch rejects', async () => {
    setTitleProxyTemplate('https://p.example/f?u={url}');
    const fetchFn = vi.fn().mockRejectedValue(new Error('network'));
    expect(await fetchYouTubeOembed(video, fetchFn as unknown as typeof fetch)).toBeNull();
  });
});
