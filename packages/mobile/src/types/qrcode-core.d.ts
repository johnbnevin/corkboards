/**
 * Type declarations for the deep import `qrcode/lib/core/qrcode`.
 *
 * The package's public entry points all render — to a canvas, a DOM data URL,
 * or a file — and none of that exists in React Native. The core module is the
 * encoder alone: pure JS, no DOM, no `fs`, safe under Metro. `@types/qrcode`
 * only covers the public entry points, so the one function used here is
 * declared directly.
 */
declare module 'qrcode/lib/core/qrcode' {
  export interface QrCodeModules {
    /** Width and height of the matrix, in modules. */
    size: number;
    /** Row-major, one byte per module: 1 = dark. Length is `size * size`. */
    data: Uint8Array;
  }

  export interface QrCodeCreateOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    version?: number;
  }

  export function create(data: string, options?: QrCodeCreateOptions): { modules: QrCodeModules };
}
