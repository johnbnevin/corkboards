import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TestApp } from '@/test/TestApp';
import { NoteContent } from './NoteContent';
import type { NostrEvent } from '@nostrify/nostrify';

function makeEvent(content: string): NostrEvent {
  return {
    id: 'test-id',
    pubkey: 'test-pubkey',
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content,
    sig: 'test-sig',
  };
}

describe('NoteContent', () => {
  it('renders text content', () => {
    const event: NostrEvent = {
      id: 'test-id',
      pubkey: 'test-pubkey',
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [],
      content: 'Check out this link: https://example.com',
      sig: 'test-sig',
    };

    render(
      <TestApp>
        <NoteContent event={event} />
      </TestApp>
    );

    // Text before URL should be rendered
    expect(screen.getByText(/Check out this link:/)).toBeInTheDocument();
  });

  it('handles text without URLs correctly', () => {
    const event: NostrEvent = {
      id: 'test-id',
      pubkey: 'test-pubkey',
      created_at: Math.floor(Date.now() / 1000),
      kind: 1111,
      tags: [],
      content: 'This is just plain text without any links.',
      sig: 'test-sig',
    };

    render(
      <TestApp>
        <NoteContent event={event} />
      </TestApp>
    );

    expect(screen.getByText('This is just plain text without any links.')).toBeInTheDocument();
  });

  it('renders content with hashtags', () => {
    const event: NostrEvent = {
      id: 'test-id',
      pubkey: 'test-pubkey',
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [],
      content: 'This is a post about #nostr and #bitcoin development.',
      sig: 'test-sig',
    };

    render(
      <TestApp>
        <NoteContent event={event} />
      </TestApp>
    );

    // The content should be rendered (hashtags may or may not be linked depending on impl)
    expect(screen.getByText(/This is a post about/)).toBeInTheDocument();
  });

  it('does not render javascript: protocol links as anchor tags', () => {
    const { container } = render(
      <TestApp>
        <NoteContent event={makeEvent('Click [here](javascript:alert(1)) for more')} />
      </TestApp>
    );

    expect(container.querySelectorAll('a[href^="javascript:"]')).toHaveLength(0);
  });

  it('does not render data: protocol links as anchor tags', () => {
    const { container } = render(
      <TestApp>
        <NoteContent event={makeEvent('See [this](data:text/html,<script>alert(1)</script>)')} />
      </TestApp>
    );

    expect(container.querySelectorAll('a[href^="data:"]')).toHaveLength(0);
  });

  it('renders NIP-30 custom emoji shortcode as an img element', () => {
    const event: NostrEvent = {
      ...makeEvent(':parrot: is cool'),
      tags: [['emoji', 'parrot', 'https://example.com/parrot.gif']],
    };
    const { container } = render(
      <TestApp>
        <NoteContent event={event} />
      </TestApp>
    );
    const img = container.querySelector('img[alt="parrot"]');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'https://example.com/parrot.gif');
  });

  it('renders unknown emoji shortcode as literal text when no matching tag', () => {
    render(
      <TestApp>
        <NoteContent event={makeEvent('no match :unknown:')} />
      </TestApp>
    );
    expect(screen.getByText(/:unknown:/)).toBeInTheDocument();
  });

  it('consumes nostr:npub1 identifier — does not leave raw URI as plain text', () => {
    const { container } = render(
      <TestApp>
        <NoteContent event={makeEvent('Follow nostr:npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')} />
      </TestApp>
    );
    expect(container.textContent).not.toContain('nostr:npub1');
  });

  it('consumes nostr:note1 identifier — does not leave raw URI as plain text', () => {
    const { container } = render(
      <TestApp>
        <NoteContent event={makeEvent('See nostr:note1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')} />
      </TestApp>
    );
    expect(container.textContent).not.toContain('nostr:note1');
  });

  it('handles 10K+ character content without hanging (ReDoS guard)', () => {
    const longText = 'a'.repeat(10_001);
    const { container } = render(
      <TestApp>
        <NoteContent event={makeEvent(longText)} />
      </TestApp>
    );
    // Rendered successfully — ReDoS guard skips MARKDOWN_INDICATORS_PATTERN for oversized segments
    expect(container.firstChild).toBeTruthy();
    expect(container.textContent?.length).toBeGreaterThan(0);
  });

  it('renders nostr.build image URL via MediaLink, not as a plain WebLink card', () => {
    const { container } = render(
      <TestApp>
        <NoteContent event={makeEvent('https://nostr.build/i/abc123.jpg')} />
      </TestApp>
    );
    // WebLink renders the hostname in a card with a specific text node; MediaLink renders an img
    // The hostname should not appear as standalone text if rendered correctly as MediaLink
    const cardHostnameText = Array.from(container.querySelectorAll('.font-medium.text-sm.truncate'))
      .find(el => el.textContent === 'nostr.build');
    expect(cardHostnameText).toBeUndefined();
  });
});