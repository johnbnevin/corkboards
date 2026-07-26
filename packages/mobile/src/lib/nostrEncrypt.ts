// Single source of truth lives in @core/nostrEncrypt — this file only re-exports
// it so existing `../lib/nostrEncrypt` imports keep working. Was hand-duplicated
// with web before, which caused drift (same fix applied twice).
export * from '@core/nostrEncrypt';
