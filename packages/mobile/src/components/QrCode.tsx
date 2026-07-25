/**
 * QrCode — render a string as a scannable QR code.
 *
 * React Native has no canvas and this app carries no SVG renderer, so the code
 * is drawn as plain Views. Each row is one View, and runs of same-colour modules
 * collapse into a single child: a 33×33 code is ~1,000 modules but only ~250
 * views once the runs are merged, which is the difference between a modal that
 * opens instantly and one that visibly hitches.
 *
 * Always dark-on-white regardless of theme, matching web — an inverted QR code
 * is not reliably scannable, and a payment code that only some cameras can read
 * is worse than one that ignores the theme.
 *
 * Mirrors packages/web/src/components/QrCode.tsx.
 */
import { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { create as createQrMatrix } from 'qrcode/lib/core/qrcode';

interface QrCodeProps {
  /** The payload to encode. Nothing renders while this is empty. */
  value: string;
  /** Width and height of the rendered code, in points (before the quiet zone). */
  size?: number;
}

/** One horizontal run of identical modules. */
interface Run {
  dark: boolean;
  length: number;
}

export function QrCode({ value, size = 240 }: QrCodeProps) {
  const matrix = useMemo(() => {
    if (!value) return null;
    try {
      // Medium recovers from glare or a fingerprint without inflating the code
      // to a density phone cameras struggle with.
      const { modules } = createQrMatrix(value, { errorCorrectionLevel: 'M' });
      const rows: Run[][] = [];
      for (let y = 0; y < modules.size; y++) {
        const runs: Run[] = [];
        for (let x = 0; x < modules.size; x++) {
          const dark = modules.data[y * modules.size + x] === 1;
          const last = runs[runs.length - 1];
          if (last && last.dark === dark) last.length++;
          else runs.push({ dark, length: 1 });
        }
        rows.push(runs);
      }
      return { rows, count: modules.size };
    } catch {
      return null;
    }
  }, [value]);

  if (!matrix) {
    return (
      <View style={[styles.plate, { width: size + 24, height: size + 24 }]}>
        {!!value && <Text style={styles.error}>Couldn't render the QR code</Text>}
      </View>
    );
  }

  // Whole points per module: a fractional module width leaves seams between
  // rows that some scanners read as missing data.
  const moduleSize = Math.max(1, Math.floor(size / matrix.count));
  const rendered = moduleSize * matrix.count;

  return (
    <View style={[styles.plate, { width: rendered + 24, height: rendered + 24 }]}>
      <View style={{ width: rendered, height: rendered }}>
        {matrix.rows.map((runs, y) => (
          <View key={y} style={{ flexDirection: 'row', height: moduleSize }}>
            {runs.map((run, i) => (
              <View
                key={i}
                style={{
                  width: run.length * moduleSize,
                  height: moduleSize,
                  backgroundColor: run.dark ? '#000000' : '#ffffff',
                }}
              />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  plate: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  error: {
    color: '#b00020',
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: 12,
  },
});
