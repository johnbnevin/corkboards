/**
 * QrCode — render a string as a scannable QR code.
 *
 * Always rendered on a white plate with a quiet zone, in both themes. A QR code
 * inverted for dark mode is not reliably scannable: plenty of camera pipelines
 * assume dark-on-light, and a payment code that only works for some of the
 * people pointing a phone at it is worse than one that ignores the theme.
 *
 * Mirrors packages/mobile/src/components/QrCode.tsx, which draws the same
 * matrix with Views because React Native has no canvas.
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Loader2 } from 'lucide-react';

interface QrCodeProps {
  /** The payload to encode. Nothing renders while this is empty. */
  value: string;
  /** Pixel size of the rendered image. */
  size?: number;
  /** Accessible description of what the code contains. */
  label: string;
}

export function QrCode({ value, size = 240, label }: QrCodeProps) {
  const [dataUrl, setDataUrl] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!value) { setDataUrl(''); return; }
    let cancelled = false;
    setFailed(false);
    QRCode.toDataURL(value, {
      width: size,
      margin: 2,
      // Medium recovers from a fingerprint or a bit of screen glare without
      // inflating the code so much that phone cameras struggle.
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((url) => { if (!cancelled) setDataUrl(url); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [value, size]);

  if (failed) {
    return (
      <p className="text-xs text-destructive text-center">
        Couldn't render the QR code — copy the invoice instead.
      </p>
    );
  }

  return (
    <div
      className="flex items-center justify-center rounded-lg bg-white p-2"
      style={{ minHeight: size + 16 }}
    >
      {dataUrl ? (
        <img src={dataUrl} alt={label} width={size} height={size} className="block" />
      ) : (
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      )}
    </div>
  );
}
