> **Internal design document.** This file describes the HTML sanitization and content security implementation. It is not the vulnerability reporting policy — see [SECURITY.md](./SECURITY.md) for that.

# Security Implementation: User-Specific Content Rendering

## Overview
This implementation addresses the security concern of rendering HTML and media content in Nostr posts. It implements a system where **dangerous HTML rendering (using `dangerouslySetInnerHTML`) is ONLY used for the logged-in user's own content**, while all other content is safely sanitized or displayed with security warnings.

## Key Features

### 1. User's Own Content
- **Full HTML support**: Can use HTML tags, markdown, etc.
- **dangerouslySetInnerHTML**: Used ONLY for the current user's posts
- **Security checks**: Even own content is checked for dangerous patterns

### 2. Friends/Other Users' Content
- **HTML blocked**: Shows warning: "HTML content not rendered for security"
- **Safe rendering**: Markdown, URLs, media all work safely
- **Sanitization**: Uses DOMPurify for any HTML that needs processing

### 3. All Media Types Supported
- **Images**: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`
- **Video**: `.mp4`, `.webm`, `.mov`
- **Audio**: `.mp3`, `.wav`, `.ogg`
- **Files**: `.pdf`, `.txt`
- **Links**: Regular URLs
- **Hashtags**: `#tag` → links to `/t/tag`
- **Nostr references**: `npub1...`, `note1...`, etc. → links to NIP-19 pages

## Files Modified/Created

### New Files
1. **`src/lib/sanitize.ts`**: HTML sanitization utilities
   - `sanitizeHtml()`: Uses DOMPurify with strict config
   - `hasHtmlContent()`: Detects HTML presence
   - `isHtmlContentUnsafe()`: Checks for dangerous patterns

2. **`src/components/ProfileAbout.tsx`**: Safe profile rendering
   - Handles user's own profile about field with HTML
   - Shows warnings for other profiles with HTML

### Modified Files
3. **`src/components/SmartNoteContent.tsx`**: Main content renderer
   - Checks if content belongs to logged-in user
   - Uses `dangerouslySetInnerHTML` ONLY for own content
   - Shows security warnings for others' HTML

4. **`src/components/NoteContent.tsx`**: Secondary content renderer
   - Same security principles
   - Used in comments section
   - Handles mentions, hashtags, media

5. **`src/lib/noteContentParser.ts`**: Content parser
   - Handles HTML, markdown, media detection
   - Generates safe HTML strings

6. **`src/hooks/useNoteContent.ts`**: Legacy hook support
   - Maintains security principles for backward compatibility

7. **`src/pages/MultiColumnClient.tsx`**: Main app page
   - Updated to use ProfileAbout component
   - Uses SmartNoteContent for posts

8. **`package.json`**: Added DOMPurify dependency

## Security Architecture

### Flow for User's Own Post with HTML
1. User creates post with HTML
2. `SmartNoteContent` detects HTML
3. Checks `isOwnContent` → true
4. Checks `isHtmlContentUnsafe()` → false
5. Parses content → generates HTML
6. **Uses dangerouslySetInnerHTML** → HTML rendered

### Flow for Friend's Post with HTML
1. Friend's post contains HTML
2. `SmartNoteContent` detects HTML
3. Checks `isOwnContent` → false
4. **Shows warning**: "HTML content not rendered for security"
5. No dangerous HTML rendered

### Flow for Markdown/Media
1. Detects markdown/media URLs
2. Parses to safe HTML
3. Uses dangerouslySetInnerHTML (safe because we generated the HTML)
4. Media embedded as safe `<img>`, `<video>`, `<audio>` tags

## Example Scenarios

### Scenario 1: User's Own Post
**Content**: `<strong>Bold text</strong> https://example.com/image.jpg`
**Result**: Bold text + image displayed

### Scenario 2: Friend's Post
**Content**: `<script>alert('XSS')</script> Hello`
**Result**: Warning shown, no script executed

### Scenario 3: Friend's Post (Safe)
**Content**: `Check this out https://example.com/video.mp4`
**Result**: Video player displayed, no warnings

### Scenario 4: Markdown in Own Post
**Content**: `**Bold** and #tags`
**Result**: Bold text and clickable hashtag

## DOMPurify Configuration

```javascript
const config = {
  ALLOWED_TAGS: ['b', 'i', 'u', 'em', 'strong', ...],
  ALLOWED_ATTR: ['href', 'src', 'alt', ...],
  FORBID_TAGS: ['script', 'style', 'iframe', ...],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', ...],
  // ... strict security
};
```

## Future Considerations

1. **NIP19Page**: Should use same pattern when fully implemented
2. **Comments**: Already uses `NoteContent` which is secure
3. **Profile Editing**: ProfileAbout handles safe rendering
4. **Direct Messages**: Would need similar implementation

## Testing Checklist

- [ ] User's own posts with HTML render correctly
- [ ] Friends' HTML posts show warnings
- [ ] Markdown works in all contexts
- [ ] All media types (image, video, audio, PDF) display
- [ ] Hashtags and Nostr references are clickable
- [ ] Profile about fields render safely
- [ ] No XSS vulnerabilities in any content path
