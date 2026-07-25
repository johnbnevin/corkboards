/**
 * useQrScanner — drive the device camera and decode QR codes from its frames.
 *
 * Decoding is done by jsQR in plain JavaScript rather than the browser's
 * `BarcodeDetector`. `BarcodeDetector` would be faster, but it doesn't exist in
 * WebKitGTK — the engine the Linux desktop build runs in — nor in Firefox, so
 * relying on it would ship a scanner that only works for some users. jsQR works
 * identically everywhere, including inside the Tauri webview.
 *
 * The hook owns the camera lifecycle: it stops every track on unmount, on
 * error, and as soon as a code is found, so the camera indicator never stays
 * lit after the dialog closes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

/** How often to sample a frame. Faster than this just burns CPU on a decode
 *  that is already running per-frame at video resolution. */
const SCAN_INTERVAL_MS = 150;

export type QrScannerStatus = 'idle' | 'starting' | 'scanning' | 'error';

export interface UseQrScannerResult {
  /** Attach to a `<video>` element; the stream is bound to it once started.
   *  Typed as a MutableRefObject so it satisfies React's `ref` prop, which
   *  needs to be able to write null back on unmount. */
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  status: QrScannerStatus;
  /** Human-readable reason the camera isn't running, if any. */
  error: string | null;
  start: () => void;
  stop: () => void;
  /** Decode a still image (a screenshot or saved QR) instead of a live frame. */
  scanImageFile: (file: File) => Promise<string | null>;
}

/** True when this browser can even attempt a camera capture. */
export function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * @param onResult - Called once with the decoded text. Scanning stops first, so
 *   a single QR in view can't fire the handler repeatedly.
 */
export function useQrScanner(onResult: (text: string) => void): UseQrScannerResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Held in a ref so the scan loop always calls the latest handler without
  // being torn down and restarted whenever the caller re-renders.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  const [status, setStatus] = useState<QrScannerStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus(prev => (prev === 'error' ? prev : 'idle'));
  }, []);

  /** Grab the current video frame and try to decode it. */
  const scanFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return;

    const canvas = (canvasRef.current ??= document.createElement('canvas'));
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    let decoded: ReturnType<typeof jsQR>;
    try {
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      decoded = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
    } catch {
      return; // A transient frame read failure isn't worth surfacing.
    }
    if (decoded?.data) {
      stop();
      onResultRef.current(decoded.data);
    }
  }, [stop]);

  const start = useCallback(() => {
    if (!cameraAvailable()) {
      setStatus('error');
      setError('This device has no camera available to the app.');
      return;
    }
    setStatus('starting');
    setError(null);

    navigator.mediaDevices
      // The rear camera is the one pointed at a QR code on a screen or a wall.
      // `ideal` rather than `exact` so a laptop with only a front camera still
      // gets a stream instead of an OverconstrainedError.
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(stream => {
        // The dialog may have closed while the permission prompt was up.
        if (!videoRef.current) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        streamRef.current = stream;
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => {});
        setStatus('scanning');
        timerRef.current = setInterval(scanFrame, SCAN_INTERVAL_MS);
      })
      .catch((err: unknown) => {
        setStatus('error');
        const name = err instanceof DOMException ? err.name : '';
        setError(
          name === 'NotAllowedError'
            ? 'Camera permission was denied. You can paste the code instead.'
            : name === 'NotFoundError'
              ? 'No camera found. You can paste the code instead.'
              : 'Could not start the camera. You can paste the code instead.',
        );
      });
  }, [scanFrame]);

  const scanImageFile = useCallback(async (file: File): Promise<string | null> => {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Could not read that image'));
        el.src = url;
      });
      const canvas = (canvasRef.current ??= document.createElement('canvas'));
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }, []);

  // Release the camera if the component goes away mid-scan.
  useEffect(() => stop, [stop]);

  return { videoRef, status, error, start, stop, scanImageFile };
}
