/**
 * InlineMarkdown — renders a run of text with inline markdown emphasis
 * (bold / italic / strikethrough / inline code, and link styling) as nested
 * <Text>, so it can sit inside NoteContent's parent <Text> and flow inline.
 *
 * Parsing is the shared, unit-tested @core/markdownParse.parseInlineSpans; this
 * file only maps spans → styled <Text>. Block-level markdown (headings, lists,
 * fenced code) isn't rendered in the inline feed path because RN <Text> can't
 * host the <View> layout those need — the feed's markdown is overwhelmingly
 * inline emphasis, and mobile's parseContent already extracts links/media first.
 *
 * Links are styled but not auto-opened: the feed pre-converts [text](url) to
 * plain "text (url)" before this runs, and bypassing the app's tracker-aware
 * link handling would leak the privacy warning. Styling-only keeps parity
 * without that regression.
 */
import { useMemo } from 'react';
import { Text, StyleSheet, Platform } from 'react-native';
import { parseInlineSpans } from '@core/markdownParse';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export function InlineMarkdown({ text }: { text: string }) {
  const spans = useMemo(() => parseInlineSpans(text), [text]);
  return (
    <>
      {spans.map((s, i) => {
        const style = [
          s.bold && styles.bold,
          s.italic && styles.italic,
          s.strike && styles.strike,
          s.code && styles.code,
          s.link && styles.link,
        ].filter(Boolean) as object[];
        return style.length > 0
          ? <Text key={i} style={style}>{s.text}</Text>
          : <Text key={i}>{s.text}</Text>;
      })}
    </>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  code: { fontFamily: MONO, backgroundColor: 'rgba(255,255,255,0.08)' },
  link: { color: '#60a5fa', textDecorationLine: 'underline' },
});
