import { describe, it, expect } from 'vitest'
import { visibleLength, findVisibleCutoff, truncateForPreview } from './textTruncation'

describe('truncateForPreview', () => {
  const url = 'https://blossom.primal.net/2b5c2308079f5b973497b6470f2e17a68ac892a68da0162ac98368d67b7fe6d9.jpg'

  it('adds no ellipsis when extending past the URL consumed the whole note', () => {
    // The real-world case: a short caption plus a trailing image URL. The note
    // is "too long" by visible-character count, but findVisibleCutoff extends
    // the cut to the end of the URL — which is the end of the content. The old
    // `slice(...).trimEnd() + '…'` therefore appended an ellipsis to the FULL
    // text, producing `…/abc.jpg…`: one token, no whitespace. Every media check
    // is anchored to the end of the path, so that URL stopped being recognized
    // as an image, and the note's imeta copy of the same picture was then
    // appended as "not already shown inline".
    const content = `9,000 fraudulent voters purged.\n\nIt must be hard to be a democrat\n\n${url}`
    const out = truncateForPreview(content, 125)
    expect(out).toBe(content)
    expect(out).not.toContain(`${url}…`)
    expect(out.endsWith('.jpg')).toBe(true)
  })

  it('separates the ellipsis from a URL when there is more content after it', () => {
    const content = `${url} and then a good deal more text that keeps going past the limit`
    const out = truncateForPreview(content, 10)
    expect(out).toContain(url)
    expect(out).not.toContain(`${url}…`)
    expect(out.endsWith(' …')).toBe(true)
  })

  it('leaves the URL parseable as media after truncation', () => {
    const content = `look at this ${url} and then some more text that runs well past the limit `.repeat(3)
    const out = truncateForPreview(content, 40)
    const token = out.split(/\s+/).find(t => t.startsWith('http'))
    expect(token).toBe(url)
    expect(/\.(jpg|jpeg|png|gif|webp)$/i.test(new URL(token!).pathname)).toBe(true)
  })

  it('returns short content untouched, with no ellipsis', () => {
    expect(truncateForPreview('short note', 125)).toBe('short note')
  })

  it('truncates plain text at roughly the target', () => {
    const content = 'a'.repeat(300)
    const out = truncateForPreview(content, 125)
    expect(out.endsWith(' …')).toBe(true)
    expect(out.length).toBeLessThan(content.length)
  })

  it('agrees with findVisibleCutoff about where the cut lands', () => {
    const content = `some text ${url} trailing words here`
    const cut = findVisibleCutoff(content, 20)
    expect(truncateForPreview(content, 20)).toBe(content.slice(0, cut).trimEnd() + ' …')
  })

  it('does not count nostr refs toward the visible length', () => {
    const withRef = 'hello nostr:npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq world'
    expect(visibleLength(withRef)).toBeLessThan(withRef.length)
  })
})
